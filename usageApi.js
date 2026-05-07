import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const API_BASE_URL = 'https://chatgpt.com';
const SUMMARY_ENDPOINT = '/backend-api/wham/usage';
const ME_ENDPOINT = '/backend-api/me';

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

export class UsageApiClient {
    constructor() {
        this._session = new Soup.Session({
            timeout: 30,
        });
    }

    async fetchSummary(cookies) {
        // Step 1: Get the access token using the cookies
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
        const usagePayload = await this._getJsonWithAuth(SUMMARY_ENDPOINT, sessionData.accessToken);
        
        // Step 3: Ensure we have an email (fallback to /me if missing from usage payload)
        if (!usagePayload.email) {
            try {
                const meData = await this._getJsonWithAuth(ME_ENDPOINT, sessionData.accessToken);
                if (meData && meData.email) {
                    usagePayload.email = meData.email;
                }
            } catch (e) {
                log(`CodexBar: Failed to fetch email from /me fallback: ${e.message}`);
            }
        }

        return this.normalizeSummary(usagePayload);
    }

    destroy() {
        this._session.abort();
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
        
        if (statusCode >= 400) {
            log(`CodexBar: API Error ${statusCode} - Body: ${body}`);
        }

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


    normalizeSummary(payload) {
        // Log keys of the payload for debugging if no windows are found
        const windows = this.extractWindows(payload);
        
        if (windows.length === 0) {
            log(`CodexBar: No usage windows found in payload. Keys: ${Object.keys(payload).join(', ')}`);
            log(`CodexBar: Full payload snippet: ${JSON.stringify(payload).substring(0, 1000)}`);
            // Deep log of first level of rate_limit if it exists
            if (payload.rate_limit) log(`CodexBar: rate_limit keys: ${Object.keys(payload.rate_limit).join(', ')}`);
        }

        // Sort by window size (smallest first, e.g. 3h before 24h)
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

    extractWindows(payload) {
        const windows = [];
        const seen = new Set();

        const collect = (obj) => {
            if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
            seen.add(obj);
            
            // Support for used_percent directly (often found in Free/Basic plans)
            if (obj.used_percent !== undefined) {
                const percent = parseFloat(obj.used_percent) / 100;
                if (!isNaN(percent)) {
                    windows.push({
                        used: percent, // We don't have absolute numbers, so we use the ratio
                        limit: 1,
                        percent: percent,
                        window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || obj.duration || 0,
                        reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
                    });
                }
            }

            // Look for usage/limit pairs
            // Usage variants: usage, used, count, current_usage, used_count, request_count
            // Limit variants: limit, cap, max, max_usage, usage_limit, max_requests, total
            let usedValue = obj.used ?? obj.usage ?? obj.count ?? obj.current_usage ?? obj.used_count ?? obj.request_count;
            let limitValue = obj.limit ?? obj.cap ?? obj.max ?? obj.max_usage ?? obj.usage_limit ?? obj.max_requests ?? obj.total;
            
            // Special case: remaining and limit
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
                        window_seconds: obj.window_seconds || obj.duration_seconds || obj.duration || 0,
                        reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
                    });
                }
            }

            // Recurse
            for (const key in obj) {
                collect(obj[key]);
            }
        };
        
        collect(payload);
        
        // De-duplicate windows with same window_seconds and percent
        return windows.filter((w, index, self) => 
            index === self.findIndex((t) => (
                t.window_seconds === w.window_seconds && t.percent === w.percent
            ))
        );
    }
}
