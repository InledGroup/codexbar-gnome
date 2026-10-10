
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to fetch ChatGPT/Codex usage metrics
 * directly from the OpenAI web dashboard endpoints using libsoup3.
 * Supports cancellable tokens for clean extension disabling.
 */
export class SoupApiFetcher extends UsageFetcher {
    /**
     * @param {Soup.Session|null} session - Existing network session or null to create a new one.
     */
    constructor(session) {
        super();
        if (session) {
            this._session = session;
        } else {
            this._session = new Soup.Session();
            this._session.set_timeout(30);
        }
    }

    /**
     * Fetch the usage data from OpenAI.
     * 
     * @param {string} cookies - Session cookies containing authentication details.
     * @param {object|null} extraParams - Extra options containing the cancellable token.
     * @returns {Promise<object>} The raw JSON usage payload from the API.
     *                            The raw usage JSON payload returned by the API.
     */
    async fetch(cookies, extraParams = null) {
        const cancellable = extraParams?.cancellable || null;

        if (!cookies)
            throw new UsageApiError('Authentication cookies are required.');

        let sessionData;
        try {
            sessionData = await this._getJson('/api/auth/session', cookies, cancellable);
        } catch (e) {
            throw new UsageApiError('Failed to retrieve access token: ' + e.message);
        }
        
        if (!sessionData || !sessionData.accessToken) {
            throw new UsageApiError('Failed to retrieve access token from session. Cookies might be invalid.');
        }

        const usagePayload = await this._getJsonWithAuth('/backend-api/wham/usage', sessionData.accessToken, cancellable);
        
        if (!usagePayload.email) {
            try {
                const meData = await this._getJsonWithAuth('/backend-api/me', sessionData.accessToken, cancellable);
                if (meData && meData.email) {
                    usagePayload.email = meData.email;
                }
            } catch (e) {
                // Silently ignore fallback failures
            }
        }

        return usagePayload;
    }

    /**
     * Perform a GET request using session cookies.
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
     * Helper to run the network message and parse its JSON output.
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
