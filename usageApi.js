import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';
import { SoupApiFetcher } from './adapters/SoupApiFetcher.js';
import { AntigravityLocalFetcher } from './adapters/AntigravityLocalFetcher.js';
import { CliSubprocessFetcher } from './adapters/CliSubprocessFetcher.js';

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

    let window_seconds = obj.limit_window_seconds || obj.window_seconds || obj.duration_seconds || 0;
    if (!window_seconds && obj.windowMinutes) {
        window_seconds = obj.windowMinutes * 60;
    }
    let reset_after_seconds = obj.reset_after_seconds || obj.reset_after || 0;
    if (!reset_after_seconds && obj.resetsAt) {
        const diffMs = new Date(obj.resetsAt).getTime() - Date.now();
        reset_after_seconds = Math.max(0, Math.round(diffMs / 1000));
    }

    const rawUsedPercent = obj.used_percent ?? obj.usedPercent;
    if (rawUsedPercent !== undefined) {
        const percent = normalizePercentValue(rawUsedPercent, 'used');
        if (percent !== null) {
            return {
                used: percent,
                limit: 1,
                percent,
                window_seconds,
                reset_after_seconds
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
                window_seconds,
                reset_after_seconds
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
                window_seconds,
                reset_after_seconds
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
        this._soupFetcher = new SoupApiFetcher(this._session);
        this._antigravityFetcher = new AntigravityLocalFetcher(this._session);
        this._cliFetcher = new CliSubprocessFetcher();
    }

    /**
     * Fetch usage summary from OpenAI API.
     * Obtiene el resumen de uso desde la API de OpenAI.
     */
    async fetchSummary(cookies, cancellable = null) {
        const usagePayload = await this._soupFetcher.fetch(cookies, { cancellable });
        return this.normalizeSummary(usagePayload);
    }

    /**
     * Fetch usage summary from Antigravity local server.
     * Obtiene el resumen de uso desde el servidor local de Antigravity.
     */
    async fetchAntigravitySummary(cancellable = null) {
        const usagePayload = await this._antigravityFetcher.fetch(null, { cancellable });
        return this.normalizeSummary(usagePayload, true);
    }

    /**
     * Fetch usage summary via external codexbar CLI tool.
     * Obtiene el resumen de uso mediante la herramienta externa de terminal codexbar.
     */
    async fetchCliSummary(command, cancellable = null) {
        return this._cliFetcher.fetch(command, cancellable);
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


    /**
     * Normalize the API payload into a unified structure.
     * Normaliza el payload de la API en una estructura unificada.
     */
    normalizeSummary(payload, isAntigravity = false) {
        // Detect if the provider is antigravity
        // Detectar si el proveedor es antigravity
        const isAnti = isAntigravity || 
            payload?.identity?.providerID === "antigravity" || 
            payload?.provider === "antigravity" ||
            payload?.usage?.identity?.providerID === "antigravity" ||
            (payload?.extraRateWindows && Array.isArray(payload.extraRateWindows)) ||
            (payload?.usage?.extraRateWindows && Array.isArray(payload.usage.extraRateWindows));

        const mapSingle = (obj) => {
            const win = makeWindow(obj);
            if (!win) return null;

            return {
                usedPercent: win.percent * 100,
                resetDescription: formatResetDescription(
                    win.reset_after_seconds,
                    win.window_seconds
                ) || obj?.resetDescription || '',
                windowSeconds: win.window_seconds
            };
        };

        const extraWindows = payload?.extraRateWindows || payload?.usage?.extraRateWindows;
        if (isAnti && extraWindows && Array.isArray(extraWindows)) {
            // Handle multiple quota windows specific to Antigravity
            // Manejar múltiples ventanas de cuota específicas de Antigravity
            const labels = [];
            const mappedTiers = {
                primary: null,
                secondary: null,
                tertiary: null,
                quaternary: null
            };

            const tierKeys = ["primary", "secondary", "tertiary", "quaternary"];
            extraWindows.forEach((item, idx) => {
                if (idx < 4) {
                    const tierName = tierKeys[idx];
                    mappedTiers[tierName] = mapSingle(item.window);
                    labels.push(item.title || "Usage Window");
                }
            });

            return {
                labels,
                usage: {
                    ...payload,
                    accountEmail: payload?.accountEmail || payload?.email || payload?.identity?.accountEmail || 'Antigravity User',
                    loginMethod: payload?.loginMethod || payload?.identity?.loginMethod || '',
                    updatedAt: payload?.updatedAt || new Date().toISOString(),
                    ...mappedTiers
                }
            };
        }

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
            resetDescription: existing?.resetDescription || formatResetDescription(
                w.reset_after_seconds,
                w.window_seconds
            ) || '',
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
