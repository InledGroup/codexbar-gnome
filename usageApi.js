import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { SoupApiFetcher } from './adapters/SoupApiFetcher.js';
import { OllamaSettingsFetcher } from './adapters/OllamaSettingsFetcher.js';

import { CliSubprocessFetcher } from './adapters/CliSubprocessFetcher.js';

// This is obviously for ChatGPT, not everything. I have to change the name of the constant, but I'll do it later.
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

    let window_seconds =
        obj.limit_window_seconds ||
        obj.limitWindowSeconds ||
        obj.window_seconds ||
        obj.windowSeconds ||
        obj.duration_seconds ||
        0;
    if (!window_seconds && obj.windowMinutes) {
        window_seconds = obj.windowMinutes * 60;
    }
    let reset_after_seconds =
        obj.reset_after_seconds ||
        obj.resetAfterSeconds ||
        obj.reset_after ||
        0;
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

// Session + weekly only, like the macOS menu bar; extra per-model tiers stay in the popup.
const PANEL_TIERS = ['primary', 'secondary'];

const shortWindowLabel = (windowSeconds) => {
    if (!windowSeconds) return '';
    const hours = Math.round(windowSeconds / 3600);
    if (hours < 24) return `${hours}h`;
    const days = Math.round(hours / 24);
    return days === 7 ? 'W' : `${days}d`;
};

/**
 * Compact panel text in the style of the macOS menu bar, e.g.
 * "5h 3% · W 22% in 3h 15m". The countdown is the primary window's reset,
 * less the seconds elapsed since the data was fetched.
 */
export const formatPanelText = (usage, displayMode, elapsedSeconds = 0) => {
    if (!usage) return '';
    const parts = [];
    let resetSeconds = null;
    for (const tier of PANEL_TIERS) {
        const win = usage[tier];
        if (!win || win.usedPercent === undefined) continue;
        // Placeholder tiers (e.g. OpenRouter's balance) aren't usage windows.
        if (!win.windowSeconds && win.usedPercent === 0) continue;
        const used = Math.min(100, Math.max(0, parseFloat(win.usedPercent) || 0));
        const percent = Math.round(displayMode === 'remaining' ? 100 - used : used);
        const label = shortWindowLabel(win.windowSeconds);
        parts.push(label ? `${label} ${percent}%` : `${percent}%`);
        if (resetSeconds === null) resetSeconds = (win.resetAfterSeconds || 0) - elapsedSeconds;
    }
    if (parts.length > 0) {
        let text = parts.join(' · ');
        if (resetSeconds > 0) {
            const minutes = Math.ceil(resetSeconds / 60);
            const h = Math.floor(minutes / 60);
            const m = minutes % 60;
            text += h > 0 ? ` in ${h}h ${m}m` : ` in ${m}m`;
        }
        return text;
    }

    // Balance-only tiers (e.g. DeepSeek) or providerCost
    if (usage.primary?.resetDescription) {
        const match = usage.primary.resetDescription.match(/^\$[0-9.]+/);
        if (match) return match[0];
    }
    if (usage.providerCost && typeof usage.providerCost.used === 'number') {
        const currency = usage.providerCost.currencyCode === 'USD' ? '$' : '';
        return `${currency}${usage.providerCost.used.toFixed(2)}`;
    }

    return '';
};

/**
 * Sanitize the provider-supplied `details` array from the codexbar CLI into a
 * flat, render-safe shape. Charts are intentionally dropped (not rendered yet).
 * @param {unknown} details
 * @returns {Array<{title: string, rows: Array<{label: string, value: string, secondaryValue: string}>, hasChart: boolean}>}
 */
export function normalizeDetailSections(details) {
    if (!Array.isArray(details)) return [];

    const toText = (value) => {
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
        if (typeof value === 'boolean') return String(value);
        return '';   // null, undefined, objects, arrays -> not renderable
    };

    const sections = [];
    details.forEach((section) => {
        if (!section || typeof section !== 'object') return;

        const rows = [];
        if (Array.isArray(section.rows)) {
            section.rows.forEach((row) => {
                if (!row || typeof row !== 'object') return;
                const label = toText(row.label);
                const value = toText(row.value);
                if (!label && !value) return;
                rows.push({ label, value, secondaryValue: toText(row.secondaryValue) });
            });
        }

        if (rows.length === 0) return;   // chart-only / empty -> drop section

        sections.push({
            title: toText(section.title),
            rows,
            hasChart: Boolean(section.chart && typeof section.chart === 'object'),
        });
    });

    return sections;
}

/**
 * Derive a used-percent from detail sections (see normalizeDetailSections),
 * for providers that report a balance/budget instead of a time-bounded usage window
 * (e.g. OpenRouter's `{usedPercent: 0, windowSeconds: 0}` placeholder tier).
 * Prefers the "API key" section's budget and remaining/used if present, and
 * falls back to the "Credits" section's total added and remaining/used.
 * Returns null if no valid budget/total and remaining/used pair is found.
 * @param {Array<{title: string, rows: Array<{label: string, value: string}>}>} sections
 * @returns {number|null}
 */
export function deriveCreditsPercent(sections) {
    if (!Array.isArray(sections)) return null;

    const parseAmount = (value) => {
        if (typeof value !== 'string') return NaN;
        const match = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
        return match ? parseFloat(match[0]) : NaN;
    };

    const findSection = (titles) => sections.find(
        (section) => section && typeof section.title === 'string' &&
            titles.includes(section.title.trim().toLowerCase())
    );

    const findAmount = (section, labels) => {
        if (!section || !Array.isArray(section.rows)) return NaN;
        const row = section.rows.find(
            (r) => r && typeof r.label === 'string' &&
                labels.includes(r.label.trim().toLowerCase())
        );
        return row ? parseAmount(row.value) : NaN;
    };

    // 1. Try API key section (API key budget & remaining/used)
    const apiKeySection = findSection(['api key', 'api_key', 'api keys']);
    if (apiKeySection) {
        const budget = findAmount(apiKeySection, ['api key budget', 'budget', 'key budget']);
        if (Number.isFinite(budget) && budget > 0) {
            const remaining = findAmount(apiKeySection, ['api key remaining', 'remaining', 'key remaining']);
            if (Number.isFinite(remaining)) {
                return Math.min(100, Math.max(0, ((budget - remaining) / budget) * 100));
            }
            const used = findAmount(apiKeySection, ['api key used', 'used', 'key used']);
            if (Number.isFinite(used)) {
                return Math.min(100, Math.max(0, (used / budget) * 100));
            }
        }
    }

    // 2. Fall back to Credits section (Total added & remaining/used)
    const creditsSection = findSection(['credits', 'credit']);
    if (creditsSection) {
        const total = findAmount(creditsSection, ['total added', 'total', 'total credits', 'credits added']);
        if (Number.isFinite(total) && total > 0) {
            const remaining = findAmount(creditsSection, ['remaining', 'credits remaining']);
            if (Number.isFinite(remaining)) {
                return Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
            }
            const used = findAmount(creditsSection, ['used', 'credits used']);
            if (Number.isFinite(used)) {
                return Math.min(100, Math.max(0, (used / total) * 100));
            }
        }
    }

    return null;
}

export const calculateUsagePace = (usageWindow) => {
    const usedPercent = Number(usageWindow?.usedPercent);
    const windowSeconds = Number(usageWindow?.windowSeconds);
    const resetAfterSeconds = Number(usageWindow?.resetAfterSeconds);
    if (
        !Number.isFinite(usedPercent) ||
        !Number.isFinite(windowSeconds) ||
        !Number.isFinite(resetAfterSeconds) ||
        windowSeconds <= 0 ||
        resetAfterSeconds <= 0
    ) {
        return null;
    }

    const elapsedSeconds = Math.min(
        windowSeconds,
        Math.max(0, windowSeconds - resetAfterSeconds)
    );
    if (elapsedSeconds <= 0) return null;

    const expectedUsedPercent = elapsedSeconds / windowSeconds * 100;
    return {
        expectedUsedPercent,
        reservePercent: expectedUsedPercent - usedPercent,
    };
};

export class UsageApiClient {
    constructor(extensionPath = null) {
        this._session = new Soup.Session();
        this._session.set_timeout(30);
        this._soupFetcher = new SoupApiFetcher(this._session);
        this._ollamaFetcher = new OllamaSettingsFetcher(this._session);
        this._cliFetcher = new CliSubprocessFetcher(extensionPath);
    }

    /**
     * Fetch usage summary from a direct API provider.
     * Obtiene el resumen de uso desde un proveedor de API directa.
     *
     * @param {string} cookies - Session cookies for authentication.
     *                            Cookies de sesión para autenticación.
     * @param {string} providerId - Provider identifier ('codex' or 'ollama').
     *                              Identificador del proveedor ('codex' o 'ollama').
     * @param {Gio.Cancellable|null} cancellable - Cancellable for the request.
     *                                               Cancelable para la petición.
     */
    async fetchSummary(cookies, providerId = 'codex', cancellable = null) {
        if (providerId === 'ollama') {
            const usagePayload = await this._ollamaFetcher.fetch(cookies, { cancellable });
            return usagePayload;
        }

        const usagePayload = await this._soupFetcher.fetch(cookies, { cancellable });
        return this.normalizeSummary(usagePayload);
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
            payload?.usage?.identity?.providerID === "antigravity";

        const mapSingle = (obj) => {
            const win = makeWindow(obj);
            if (!win) return null;

            return {
                usedPercent: win.percent * 100,
                resetDescription: formatResetDescription(
                    win.reset_after_seconds,
                    win.window_seconds
                ) || obj?.resetDescription || '',
                windowSeconds: win.window_seconds,
                resetAfterSeconds: win.reset_after_seconds
            };
        };

        const codeReviewRateLimit =
            payload?.code_review_rate_limit ?? payload?.codeReviewRateLimit;
        const codeReviewWindow = codeReviewRateLimit && (
            codeReviewRateLimit.primary_window ??
            codeReviewRateLimit.primary ??
            codeReviewRateLimit
        );
        const resetCredits =
            payload?.rate_limit_reset_credits ?? payload?.rateLimitResetCredits;
        const availableResetCredits = Number(
            resetCredits?.available_count ?? resetCredits?.availableCount
        );
        const codexDetails = {
            planType: payload?.plan_type ?? payload?.planType ?? '',
            codeReview: mapSingle(codeReviewWindow),
            rateLimitResetCredits: Number.isFinite(availableResetCredits)
                ? {
                    ...resetCredits,
                    availableCount: availableResetCredits,
                }
                : null,
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
                    ...codexDetails,
                    ...mappedTiers
                }
            };
        }

        // If it already has structured tiers, normalize them in place to keep order,
        // then fill any remaining tier slots with extraRateWindows (e.g. Codex Spark)
        // Si ya tiene niveles estructurados, normalizarlos manteniendo el orden,
        // y rellenar los niveles restantes con extraRateWindows (ej. Codex Spark)
        const canonicalRateLimit = payload?.rate_limit || payload?.rateLimit;
        if (
            payload.primary ||
            payload.secondary ||
            payload.tertiary ||
            canonicalRateLimit
        ) {
            const labelForWindow = (win, key) => {
                if (key && payload?.rateWindowLabels?.[key]) return payload.rateWindowLabels[key];
                if (!win || !win.windowSeconds) return win?.resetDescription ? 'Balance' : 'Usage Window';
                const hours = Math.round(win.windowSeconds / 3600);
                if (hours >= 24) {
                    const days = Math.round(hours / 24);
                    return days === 7 ? 'Weekly Window' : `${days}-Day Window`;
                }
                return `${hours}-Hour Window`;
            };

            const queue = [];
            const tierKeys = ['primary', 'secondary', 'tertiary', 'quaternary'];
            tierKeys.forEach((key) => {
                const snakeCaseKey = `${key}_window`;
                const camelCaseKey = `${key}Window`;
                const win = mapSingle(
                    payload[key] ||
                    canonicalRateLimit?.[snakeCaseKey] ||
                    canonicalRateLimit?.[camelCaseKey]
                );
                if (win) queue.push({ win, label: labelForWindow(win, key) });
            });
            if (Array.isArray(extraWindows)) {
                extraWindows.forEach((item) => {
                    const win = mapSingle(item?.window);
                    if (win) queue.push({ win, label: item?.title || labelForWindow(win) });
                });
            }

            const additionalRateLimits =
                payload?.additional_rate_limits || payload?.additionalRateLimits;
            if (Array.isArray(additionalRateLimits)) {
                additionalRateLimits.forEach((item) => {
                    const rateLimit = item?.rate_limit || item?.rateLimit;
                    const limitName = item?.limit_name || item?.limitName || '';
                    const displayName = /codex.*spark/i.test(limitName)
                        ? 'Codex Spark'
                        : limitName;

                    ['primary', 'secondary'].forEach((key) => {
                        const rawWindow =
                            rateLimit?.[`${key}_window`] || rateLimit?.[`${key}Window`];
                        const win = mapSingle(rawWindow);
                        if (!win) return;

                        const windowLabel = labelForWindow(win);
                        let suffix = windowLabel;
                        if (windowLabel === 'Weekly Window') suffix = 'Weekly';
                        else suffix = windowLabel.replace('Hour Window', 'hour');
                        queue.push({
                            win,
                            label: displayName ? `${displayName} ${suffix}` : windowLabel,
                        });
                    });
                });
            }

            const mappedTiers = {};
            const labels = [];
            tierKeys.forEach((key, idx) => {
                mappedTiers[key] = queue[idx] ? queue[idx].win : null;
                if (queue[idx]) labels.push(queue[idx].label);
            });

            return {
                labels,
                usage: {
                    ...payload,
                    accountEmail: payload?.accountEmail || payload?.email || 'API User',
                    updatedAt: payload?.updatedAt || new Date().toISOString(),
                    ...codexDetails,
                    ...mappedTiers,
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
            windowSeconds: w.window_seconds,
            resetAfterSeconds: w.reset_after_seconds
        } : null;

        return {
            usage: {
                ...payload,
                accountEmail: payload?.accountEmail || payload?.email || 'API User',
                updatedAt: payload?.updatedAt || new Date().toISOString(),
                ...codexDetails,
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
