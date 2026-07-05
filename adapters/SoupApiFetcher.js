import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to fetch ChatGPT/Codex usage metrics
 * directly from the OpenAI web dashboard endpoints using libsoup3.
 * Supports cancellable tokens for clean extension disabling.
 * 
 * ADAPTADOR (Arquitectura Hexagonal)
 * Implementación del puerto UsageFetcher para obtener métricas de uso de ChatGPT/Codex
 * directamente desde los endpoints del panel web de OpenAI usando libsoup3.
 * Soporta tokens cancelables para una desactivación limpia de la extensión.
 */
export class SoupApiFetcher extends UsageFetcher {
    /**
     * @param {Soup.Session|null} session - Existing network session or null to create a new one.
     *                                      Sesión de red existente o null para crear una nueva.
     */
    constructor(session) {
        super();
        this._session = session || new Soup.Session({ timeout: 30 });
    }

    /**
     * Fetch the usage data from OpenAI.
     * Obtiene los datos de uso desde OpenAI.
     * 
     * @param {string} cookies - Session cookies containing authentication details.
     *                            Cookies de sesión que contienen los datos de autenticación.
     * @param {object|null} extraParams - Extra options containing the cancellable token.
     *                                    Opciones adicionales que contienen el token cancelable.
     * @returns {Promise<object>} The raw JSON usage payload from the API.
     *                            El payload JSON de uso crudo obtenido de la API.
     */
    async fetch(cookies, extraParams = null) {
        const cancellable = extraParams?.cancellable || null;

        if (!cookies)
            throw new UsageApiError('Authentication cookies are required / Las cookies de autenticación son requeridas.');

        // Step 1: Exchange cookies for a temporary OAuth access token
        // Paso 1: Intercambiar cookies por un token de acceso OAuth temporal
        let sessionData;
        try {
            sessionData = await this._getJson('/api/auth/session', cookies, cancellable);
        } catch (e) {
            throw new UsageApiError('Failed to retrieve access token: ' + e.message);
        }
        
        if (!sessionData || !sessionData.accessToken) {
            throw new UsageApiError('Failed to retrieve access token from session. Cookies might be invalid.');
        }

        // Step 2: Query the usage summary endpoint using the access token
        // Paso 2: Consultar el endpoint de resumen de uso usando el token de acceso
        const usagePayload = await this._getJsonWithAuth('/backend-api/wham/usage', sessionData.accessToken, cancellable);
        
        // Step 3: Fetch the user's email as fallback if missing from the usage payload
        // Paso 3: Obtener el email del usuario como respaldo si falta en el payload de uso
        if (!usagePayload.email) {
            try {
                const meData = await this._getJsonWithAuth('/backend-api/me', sessionData.accessToken, cancellable);
                if (meData && meData.email) {
                    usagePayload.email = meData.email;
                }
            } catch (e) {
                // Silently ignore fallback failures / Ignorar fallos de respaldo silenciosamente
            }
        }

        return usagePayload;
    }

    /**
     * Perform a GET request using session cookies.
     * Realiza una petición GET utilizando cookies de sesión.
     */
    async _getJson(path, cookies, cancellable) {
        const message = Soup.Message.new('GET', `https://chatgpt.com${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Cookie', cookies);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        const match = cookies.match(/oai-did=([^;]+)/);
        if (match) {
            headers.append('oai-device-id', match[1]);
        }

        return this._executeRequest(message, cancellable);
    }

    /**
     * Perform an authenticated GET request using the Bearer access token.
     * Realiza una petición GET autenticada utilizando el token de acceso Bearer.
     */
    async _getJsonWithAuth(path, accessToken, cancellable) {
        const message = Soup.Message.new('GET', `https://chatgpt.com${path}`);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('Authorization', `Bearer ${accessToken}`);
        headers.append('Referer', 'https://chatgpt.com/');
        headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        return this._executeRequest(message, cancellable);
    }

    /**
     * Helper to execute the network message and parse JSON output.
     * Utilidad para ejecutar el mensaje de red y parsear la salida JSON.
     */
    async _executeRequest(message, cancellable) {
        let bytes;
        try {
            bytes = await this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
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
}
