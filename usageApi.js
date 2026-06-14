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
const normalizePercentValue = (rawPercent, mode = 'used') => {
    let percent = parseFloat(rawPercent);
    if (isNaN(percent)) return null;
    percent = percent / 100;
    if (mode === 'remaining') percent = 1 - percent;
    return Math.min(1, Math.max(0, percent));
};

const makeWindow = (obj) => {
    if (!obj || typeof obj !== 'object') return null;

    const rawUsedPercent = obj.used_percent ?? obj.usedPercent;
    if (rawUsedPercent !== undefined) {
        const percent = normalizePercentValue(rawUsedPercent, 'used');
        if (percent !== null) {
            return {
                used: percent,
                limit: 1,
                percent,
                window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0,
                reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
            };
        }
    }

    const rawRemainingPercent =
        obj.remaining_percent ?? obj.remainingPercent ?? obj.percent_remaining ?? obj.percentRemaining;
    if (rawRemainingPercent !== undefined) {
        const percent = normalizePercentValue(rawRemainingPercent, 'remaining');
        if (percent !== null) {
            return {
                used: percent,
                limit: 1,
                percent,
                window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0,
                reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
            };
        }
    }

    let usedValue = obj.used ?? obj.usage ?? obj.count ?? obj.current_usage ?? obj.totalUsage ?? obj.keyUsage;
    let limitValue = obj.limit ?? obj.cap ?? obj.max ?? obj.usage_limit ?? obj.total ?? obj.totalCredits;
    
    if (usedValue === undefined && obj.remaining !== undefined && limitValue !== undefined) {
        usedValue = parseFloat(limitValue) - parseFloat(obj.remaining);
    }

    if (usedValue !== undefined && limitValue !== undefined) {
        const used = parseFloat(usedValue);
        const limit = parseFloat(limitValue);
        
        if (!isNaN(used) && !isNaN(limit) && limit > 0) {
            return {
                used,
                limit,
                percent: Math.min(1, Math.max(0, used / limit)),
                window_seconds: obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0,
                reset_after_seconds: obj.reset_after_seconds || obj.reset_after || 0
            };
        }
    }

    return null;
};

const addWindow = (target, win) => {
    if (win) target.push(win);
};

const dedupe = (items) => items.filter((w, index, self) =>
    index === self.findIndex((t) => (
        t.window_seconds === w.window_seconds &&
        Math.abs(t.percent - w.percent) < 0.0001
    ))
);

export const formatResetDescription = (seconds, windowSeconds, now = new Date()) => {
    if (!seconds || seconds <= 0) return '';

    const resetDate = new Date(now.getTime() + seconds * 1000);
    const isSameDay =
        resetDate.getFullYear() === now.getFullYear() &&
        resetDate.getMonth() === now.getMonth() &&
        resetDate.getDate() === now.getDate();
    const showDate = windowSeconds >= 7 * 24 * 3600 && !isSameDay;
    const resetStr = showDate
        ? resetDate.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
        : resetDate.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });

    if (seconds < 3600) {
        return `Resets at ${resetStr} (in ${Math.round(seconds / 60)}m)`;
    }
    const hours = Math.round(seconds / 3600);
    return `Resets at ${resetStr} (in ${hours}h)`;
};

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
        const mapSingle = (obj) => {
            const win = makeWindow(obj);
            if (!win) return null;

            return {
                usedPercent: win.percent * 100,
                resetDescription: formatResetDescription(
                    win.reset_after_seconds,
                    win.window_seconds
                ) || obj.resetDescription || '',
                windowSeconds: win.window_seconds
            };
        };

        // If it already has structured tiers, normalize them in place to keep order
        if (payload.primary || payload.secondary || payload.tertiary) {
            return {
                usage: {
                    ...payload,
                    accountEmail: payload?.accountEmail || payload?.email || 'API User',
                    updatedAt: payload?.updatedAt || new Date().toISOString(),
                    primary: mapSingle(payload.primary),
                    secondary: mapSingle(payload.secondary),
                    tertiary: mapSingle(payload.tertiary),
                    quaternary: mapSingle(payload.quaternary),
                }
            };
        }

        // Otherwise, fall back to recursive extraction
        const windows = this.extractWindows(payload);
        const sorted = windows.sort((a, b) => (a.window_seconds || 0) - (b.window_seconds || 0));
        
        const mapWindow = (w, existing) => w ? {
            usedPercent: w.percent * 100,
            resetDescription: formatResetDescription(
                w.reset_after_seconds,
                w.window_seconds
            ) || existing?.resetDescription || '',
            windowSeconds: w.window_seconds
        } : null;

        return {
            usage: {
                ...payload,
                accountEmail: payload?.accountEmail || payload?.email || 'API User',
                updatedAt: payload?.updatedAt || new Date().toISOString(),
                primary: mapWindow(sorted[0], payload?.primary) || payload?.primary || null,
                secondary: mapWindow(sorted[1], payload?.secondary) || payload?.secondary || null,
                tertiary: mapWindow(sorted[2], payload?.tertiary) || payload?.tertiary || null,
                quaternary: mapWindow(sorted[3], payload?.quaternary) || payload?.quaternary || null,
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
        const canonicalWindows = [];

        const rateLimit = payload?.rate_limit || payload?.usage?.rate_limit;
        if (rateLimit) {
            [
                'primary_window',
                'secondary_window',
                'tertiary_window',
                'quaternary_window',
                'primary',
                'secondary',
                'tertiary',
                'quaternary',
            ].forEach((key) => addWindow(canonicalWindows, makeWindow(rateLimit[key])));
        }

        ['primary', 'secondary', 'tertiary', 'quaternary'].forEach((key) =>
            addWindow(canonicalWindows, makeWindow(payload?.[key] || payload?.usage?.[key]))
        );

        if (canonicalWindows.length > 0) {
            return dedupe(canonicalWindows);
        }

        const collect = (obj) => {
            if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
            seen.add(obj);

            addWindow(windows, makeWindow(obj));

            // Recurse into all keys
            // Recorrer todas las claves
            for (const key in obj) {
                collect(obj[key]);
            }
        };
        
        collect(payload);
        
        // De-duplicate windows
        // Eliminar ventanas duplicadas
        return dedupe(windows);
    }
}
