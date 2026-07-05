import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to communicate with the local
 * Antigravity Language Server. It scans active localhost ports, connects over
 * HTTPS (bypassing the dynamic self-signed certificate restriction), and
 * queries the Connect-RPC RetrieveUserQuotaSummary endpoint.
 * Supports cancellable tokens for clean extension disabling.
 * 
 * ADAPTADOR (Arquitectura Hexagonal)
 * Implementación del puerto UsageFetcher para comunicarse con el Servidor de Lenguaje
 * local de Antigravity. Escanea los puertos activos de localhost, se conecta por
 * HTTPS (evitando el rechazo del certificado auto-firmado dinámico) y consulta el
 * endpoint de Connect-RPC RetrieveUserQuotaSummary.
 * Soporta tokens cancelables para una desactivación limpia de la extensión.
 */
export class AntigravityLocalFetcher extends UsageFetcher {
    /**
     * @param {Soup.Session|null} session - Existing network session or null to create a new one.
     *                                      Sesión de red existente o null para crear una nueva.
     */
    constructor(session) {
        super();
        this._session = session || new Soup.Session({ timeout: 10 });
    }

    /**
     * Scan active ports, query the server, and return the formatted payload.
     * Escanea los puertos activos, consulta al servidor y retorna el payload formateado.
     * 
     * @param {string|null} tokenOrCookie - Unused for local connections.
     *                                      No utilizado para conexiones locales.
     * @param {object|null} extraParams - Extra options containing the cancellable token.
     *                                    Opciones adicionales que contienen el token cancelable.
     */
    async fetch(tokenOrCookie = null, extraParams = null) {
        const cancellable = extraParams?.cancellable || null;

        // Step 1: Discover candidate ports of the local language server processes
        // Paso 1: Descubrir los puertos candidatos de los procesos del language server local
        const ports = await this._discoverPorts(cancellable);
        if (cancellable && cancellable.is_cancelled()) return null;
        
        // Add common fallback ports in case process scan returns empty
        // Añadir puertos comunes de respaldo por si el escaneo de procesos resulta vacío
        const candidates = [...ports];
        [42435, 36069, 38735, 38241, 41371, 42097].forEach(p => {
            if (!candidates.includes(p)) candidates.push(p);
        });

        // Step 2: Try to connect to each port until one responds successfully
        // Paso 2: Intentar conectar a cada puerto hasta que uno responda con éxito
        let lastError = null;
        for (const port of candidates) {
            if (cancellable && cancellable.is_cancelled()) return null;
            try {
                const data = await this._fetchFromPort(port, cancellable);
                if (data) {
                    return data;
                }
            } catch (e) {
                lastError = e;
            }
        }

        throw new UsageApiError(
            `Antigravity local server not reachable / Servidor local de Antigravity no alcanzable. Last error: ${lastError ? lastError.message : 'No ports responded'}`
        );
    }

    /**
     * Connect to a specific port and fetch the quota summary.
     * Conecta a un puerto específico y obtiene el resumen de cuota.
     */
    async _fetchFromPort(port, cancellable) {
        // Connect-RPC endpoint path
        // Ruta del endpoint de Connect-RPC
        const url = `https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`;
        const message = Soup.Message.new('POST', url);
        
        const headers = message.get_request_headers();
        headers.append('Content-Type', 'application/json');
        headers.append('Accept', 'application/json');
        
        // CRITICAL FIX: Intercept TLS validation and accept self-signed certificates on localhost.
        // SOLUCIÓN CLAVE: Interceptar la validación TLS y aceptar certificados auto-firmados en localhost.
        message.connect('accept-certificate', (msg, cert, errors) => {
            return true; // Trusted because it is local loopback / Confiable por ser bucle local
        });
        
        // Connect-RPC JSON POST requires an empty JSON body '{}'
        // Las peticiones POST de Connect-RPC por JSON requieren un cuerpo vacío '{}'
        const bodyBytes = new TextEncoder().encode('{}');
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(bodyBytes));
        
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
        } catch (error) {
            throw new Error(`Port ${port} failed: ${error.message}`);
        }
        
        const statusCode = message.get_status();
        const body = new TextDecoder().decode(bytes?.toArray?.() ?? bytes?.get_data?.() ?? []);
        
        if (statusCode < 200 || statusCode >= 300) {
            throw new Error(`HTTP ${statusCode}: ${body.substring(0, 100)}`);
        }
        
        let payload;
        try {
            payload = JSON.parse(body);
        } catch (e) {
            throw new Error(`Invalid JSON format: ${e.message}`);
        }
        
        return this._normalizeResponse(payload);
    }

    /**
     * Normalize the Connect-RPC response structure to mock the CLI command output format.
     * Normaliza la respuesta del Connect-RPC para simular el formato del CLI de codexbar.
     */
    _normalizeResponse(payload) {
        const extraRateWindows = [];
        let primary = null, secondary = null, tertiary = null, quaternary = null;
        
        if (payload?.response?.groups && Array.isArray(payload.response.groups)) {
            let index = 0;
            for (const group of payload.response.groups) {
                if (!group.buckets || !Array.isArray(group.buckets)) continue;
                
                for (const bucket of group.buckets) {
                    const windowMinutes = bucket.window === 'weekly' ? 10080 : 300;
                    const usedPercent = (1 - (bucket.remainingFraction ?? 1.0)) * 100;
                    const resetsAt = bucket.resetTime || new Date().toISOString();
                    const resetDescription = bucket.description || '';
                    
                    const win = {
                        usedPercent: usedPercent,
                        windowMinutes: windowMinutes,
                        resetsAt: resetsAt,
                        resetDescription: resetDescription
                    };
                    
                    extraRateWindows.push({
                        title: `${group.displayName || "Quota"} ${bucket.displayName || "Limit"}`,
                        id: bucket.bucketId || `antigravity-bucket-${index}`,
                        window: win
                    });
                    
                    if (index === 0) primary = win;
                    else if (index === 1) secondary = win;
                    else if (index === 2) tertiary = win;
                    else if (index === 3) quaternary = win;
                    index++;
                }
            }
        }
        
        return {
            provider: "antigravity",
            source: "api",
            extraRateWindows: extraRateWindows,
            email: "Antigravity User",
            accountEmail: "Antigravity User",
            loginMethod: "Google AI Pro",
            updatedAt: new Date().toISOString(),
            primary: primary,
            secondary: secondary,
            tertiary: tertiary,
            quaternary: quaternary
        };
    }

    /**
     * Scan the OS system for active listening ports belonging to Antigravity/agy.
     * Escanea el sistema operativo en busca de puertos activos de Antigravity/agy.
     */
    async _discoverPorts(cancellable) {
        const ports = [];
        
        // Method A: run 'ss -lntp' to list socket processes
        // Método A: ejecutar 'ss -lntp' para listar procesos de sockets
        try {
            const proc = Gio.Subprocess.new(
                ["ss", "-lnt", "-p"],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            const [stdout] = await new Promise((resolve) => {
                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, out] = p.communicate_utf8_finish(res);
                        resolve([out || ""]);
                    } catch (e) {
                        resolve([""]);
                    }
                });
            });
            
            if (stdout) {
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const matchPort = line.match(/(?:127\.0\.0\.1|\[::1\]):(\d+)/);
                    if (matchPort) {
                        const port = parseInt(matchPort[1], 10);
                        // Check if the process name column contains agy, Antigravity, or language_server
                        if (line.includes('"agy"') || line.includes('"Antigravity"') || line.includes('"language_server"') || line.includes('"language-server"')) {
                            if (!ports.includes(port)) {
                                ports.push(port);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore ss failure, fallback to /proc/net/tcp
        }
        
        // Method B: Parse /proc/net/tcp directly (100% pure JS, no subprocess needed)
        // Método B: Parsear /proc/net/tcp directamente (100% JS puro, sin subprocesos)
        if (ports.length === 0) {
            try {
                const tcpFile = Gio.File.new_for_path('/proc/net/tcp');
                const [, content] = await new Promise((resolve) => {
                    tcpFile.load_contents_async(cancellable, (file, res) => {
                        try {
                            const [ok, data] = file.load_contents_finish(res);
                            resolve([ok, new TextDecoder().decode(data)]);
                        } catch (e) {
                            resolve([false, ""]);
                        }
                    });
                });

                if (content) {
                    const lines = content.split('\n');
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        const parts = line.split(/\s+/);
                        if (parts.length > 2) {
                            const localAddr = parts[1];
                            const state = parts[3];
                            if (state === '0A') { // State 0A = LISTEN
                                const addrParts = localAddr.split(':');
                                if (addrParts.length === 2) {
                                    const ipHex = addrParts[0];
                                    const portHex = addrParts[1];
                                    // Accept local loopback (0100007F) or wildcard (00000000)
                                    if (ipHex === '0100007F' || ipHex === '00000000') {
                                        const port = parseInt(portHex, 16);
                                        if (!ports.includes(port)) {
                                            ports.push(port);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Ignore
            }
        }
        
        return ports;
    }
}
