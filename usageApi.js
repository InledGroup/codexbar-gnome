import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API_BASE_URL = 'https://chatgpt.com';
const SUMMARY_ENDPOINT = '/backend-api/wham/usage';
const ME_ENDPOINT = '/backend-api/me';

/**
 * Custom error class for API related issues.
 * Clase de error personalizada para problemas relacionados con la API.
 */
export class UsageApiError extends Error {
    constructor(message, {statusCode = 0, payload = null} = {}) {
        super(message);
        this.name = 'UsageApiError';
        this.statusCode = statusCode;
        this.payload = payload;
    }

    get isAuthError() {
        return this.statusCode === 401 || this.statusCode === 403;
    }
}

/**
 * Client for fetching and parsing usage data from OpenAI/ChatGPT.
 * Cliente para obtener y parsear datos de uso de OpenAI/ChatGPT.
 */
export class UsageApiClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 30,
        });
    }

    /**
     * Fetch usage summary from OpenAI API.
     * Obtiene el resumen de uso desde la API de OpenAI.
     */
    async fetchSummary(cookies) {
        // Step 1: Get the access token using the cookies
        // Paso 1: Obtener el token de acceso usando las cookies
        let sessionData;
        try {
            sessionData = await this._getJson('/api/auth/session', cookies);
        } catch (e) {
            throw new UsageApiError('Failed to retrieve access token: ' + e.message);
        }
        
        if (!sessionData || !sessionData.accessToken) {
            throw new UsageApiError('Failed to retrieve access token from session. Cookies might be invalid.');
        }

        // Step 2: Use the access token to fetch usage
        // Paso 2: Usar el token de acceso para obtener el uso
        const usagePayload = await this._getJsonWithAuth(SUMMARY_ENDPOINT, sessionData.accessToken);
        
        // Step 3: Ensure we have an email (fallback to /me if missing from usage payload)
        // Paso 3: Asegurar que tenemos un email (respaldo en /me si falta en el payload de uso)
        if (!usagePayload.email) {
            try {
                const meData = await this._getJsonWithAuth(ME_ENDPOINT, sessionData.accessToken);
                if (meData && meData.email) {
                    usagePayload.email = meData.email;
                }
            } catch (e) {
                // Silently fail email fallback
                // Fallo silencioso del respaldo de email
            }
        }

        return this.normalizeSummary(usagePayload);
    }

    /**
     * Abort any pending requests and clean up session.
     * Aborta cualquier petición pendiente y limpia la sesión.
     */
    destroy() {
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }

    async _getJson(path, cookies) {
        if (!cookies)
            throw new UsageApiError('Authentication cookies are required.');

        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Cookie', cookies);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        // Extract oai-did from cookies if present
        const match = cookies.match(/oai-did=([^;]+)/);
        if (match) {
            headers.append('oai-device-id', match[1]);
        }

        return this._executeRequest(message);
    }

    async _getJsonWithAuth(path, accessToken) {
        const message = Soup.Message.new('GET', `${API_BASE_URL}${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Authorization', `Bearer ${accessToken}`);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        return this._executeRequest(message);
    }

    async _executeRequest(message) {
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
            );
        } catch (error) {
            throw new UsageApiError(error.message || String(error));
        }

        const statusCode = message.get_status();
        const body = new TextDecoder().decode(bytes?.toArray?.() ?? bytes?.get_data?.() ?? []);
        
        let payload = null;
        try {
            payload = body ? JSON.parse(body) : null;
        } catch (error) {
            if (statusCode >= 400) {
                throw new UsageApiError(`HTTP ${statusCode}: ${body.substring(0, 100)}`, { statusCode });
            }
            throw new UsageApiError(`Invalid JSON: ${error.message}`, { statusCode });
        }

        if (statusCode < 200 || statusCode >= 300) {
            let messageText = payload?.message || payload?.error?.message || payload?.error || `HTTP ${statusCode}`;
            if (typeof messageText === 'object') messageText = JSON.stringify(messageText);
            throw new UsageApiError(messageText, {statusCode, payload});
        }

        return payload;
    }


    /**
     * Normalize the API payload into a unified structure.
     * Normaliza el payload de la API en una estructura unificada.
     */
    normalizeSummary(payload) {
        const windows = this.extractWindows(payload);
        
        // Sort by window size (smallest first)
        // Ordenar por tamaño de ventana (más pequeña primero)
        const sorted = windows.sort((a, b) => (a.window_seconds || 0) - (b.window_seconds || 0));
        
        const formatReset = (seconds) => {
            if (!seconds) return '';
            if (seconds < 60) return `Resets in ${Math.round(seconds)}s`;
            if (seconds < 3600) return `Resets in ${Math.round(seconds / 60)}m`;
            return `Resets in ${Math.round(seconds / 3600)}h`;
        };

        const mapWindow = (w) => w ? {
            usedPercent: w.percent * 100,
            resetDescription: formatReset(w.reset_after_seconds),
            windowSeconds: w.window_seconds
        } : null;

        return {
            usage: {
                accountEmail: payload?.email || 'API User',
                updatedAt: new Date().toISOString(),
                primary: mapWindow(sorted[0]),
                secondary: mapWindow(sorted[1]),
                tertiary: mapWindow(sorted[2]),
                quaternary: mapWindow(sorted[3]),
            }
        };
    }

    /**
     * Recursively extract usage windows from any JSON structure.
     * Extrae recursivamente las ventanas de uso de cualquier estructura JSON.
     */
    extractWindows(payload) {
        const windows = [];
        const seen = new Set();

        const collect = (obj) => {
            if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
            seen.add(obj);
            
            // Support for used_percent directly (OpenAI Free plans)
            // Soporte para used_percent directamente (planes gratuitos de OpenAI)
            if (obj.used_percent !== undefined) {
                const percent = parseFloat(obj.used_percent) / 100;
                if (!isNaN(percent)) {
                    windows.push({
                        used: percent,
                        limit: 1,
                        percent: percent,
                        window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0,
                        reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
                    });
                }
            }

            // Look for usage/limit pairs
            // Buscar pares de uso/límite
            let usedValue = obj.used ?? obj.usage ?? obj.count ?? obj.current_usage;
            let limitValue = obj.limit ?? obj.cap ?? obj.max ?? obj.usage_limit ?? obj.total;
            
            // Handle 'remaining' + 'total' case
            // Manejar caso de 'restante' + 'total'
            if (usedValue === undefined && obj.remaining !== undefined && limitValue !== undefined) {
                usedValue = parseFloat(limitValue) - parseFloat(obj.remaining);
            }

            if (usedValue !== undefined && limitValue !== undefined) {
                const used = parseFloat(usedValue);
                const limit = parseFloat(limitValue);
                
                if (!isNaN(used) && !isNaN(limit) && limit > 0) {
                    windows.push({
                        used: used,
                        limit: limit,
                        percent: used / limit,
                        window_seconds: obj.window_seconds || obj.duration_seconds || 0,
                        reset_after_seconds: obj.reset_after_seconds || 0
                    });
                }
            }

            // Recurse into all keys
            // Recorrer todas las claves
            for (const key in obj) {
                collect(obj[key]);
            }
        };
        
        collect(payload);
        
        // De-duplicate windows
        // Eliminar ventanas duplicadas
        return windows.filter((w, index, self) => 
            index === self.findIndex((t) => (
                t.window_seconds === w.window_seconds && t.percent === w.percent
            ))
        );
    }
}
