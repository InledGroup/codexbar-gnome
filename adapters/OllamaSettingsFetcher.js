
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError, formatResetDescription } from '../usageApi.js';

const OLLAMA_SETTINGS_URL = 'https://ollama.com/settings';
const OLLAMA_BILLING_URL = 'https://ollama.com/settings/billing';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to fetch Ollama Cloud usage metrics
 * directly from the ollama.com/settings page using browser cookies.
 * Parses the HTML to extract session and weekly quota bars.
 *
 * ADAPTADOR (Arquitectura Hexagonal)
 */
export class OllamaSettingsFetcher extends UsageFetcher {
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
     * Fetch the usage data from ollama.com/settings.
     *
     * @param {string} cookies - Session cookies for ollama.com authentication.
     * @param {object|null} extraParams - Extra options containing the cancellable token.
     *                                    Opciones adicionales que contienen el token cancelable.
     * @returns {Promise<object>} The parsed usage payload with session and weekly windows.
     */
    async fetch(cookies, extraParams = null) {
        const cancellable = extraParams?.cancellable || null;

        if (!cookies)
            throw new UsageApiError('Authentication cookies are required.');

        const html = await this._getSettingsHtml(cookies, cancellable);

        let billingHtml = null;
        if (this._hasCreditBlock(this._htmlToText(html))) {
            try {
                billingHtml = await this._getBillingHtml(cookies, cancellable);
            } catch (e) {
                billingHtml = null;
            }
        }

        return this._parseSettingsHtml(html, billingHtml);
    }

    /**
     * Fetch the settings page HTML.
     */
    async _getSettingsHtml(cookies, cancellable) {
        return this._fetchHtml(OLLAMA_SETTINGS_URL, cookies, cancellable);
    }

    /**
     * Fetch the billing page HTML for the exact renewal date.
     * Falls back to the relative reset text when unavailable.
     */
    async _getBillingHtml(cookies, cancellable) {
        return this._fetchHtml(OLLAMA_BILLING_URL, cookies, cancellable);
    }

    /**
     * Shared authenticated HTML fetch.
     */
    async _fetchHtml(url, cookies, cancellable) {
        const message = Soup.Message.new('GET', url);
        const headers = message.get_request_headers();
        headers.append('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
        headers.append('Cookie', cookies);
        headers.append('Referer', 'https://ollama.com/');
        headers.append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        const body = await this._executeTextRequest(message, cancellable);
        return body;
    }

    /**
     * Execute a text (non-JSON) HTTP request.
     */
    async _executeTextRequest(message, cancellable) {
        let bytes;
        try {
            bytes = await this._sendAndRead(message, cancellable);
        } catch (error) {
            throw new UsageApiError(error.message || String(error));
        }

        const statusCode = message.get_status();
        const body = new TextDecoder().decode(bytes?.toArray?.() ?? bytes?.get_data?.() ?? []);
        if (statusCode < 200 || statusCode >= 300) {
            throw new UsageApiError(`HTTP ${statusCode}`, { statusCode });
        }

        return body;
    }

    /**
     * Promise wrapper for Soup async send.
     */
    _sendAndRead(message, cancellable) {
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (session, result) => {
                    try {
                        resolve(session.send_and_read_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                }
            );
        });
    }

    /**
     * Parse the settings HTML into a usage payload.
     */
    /**
     * Detect the monthly credit-pool block (transparent per-token pricing).
     */
    _hasCreditBlock(text) {
        return /monthly usage\s*\$[\d,]+/i.test(text) ||
            (text.toLowerCase().includes('usage credits') && /\$[\d,]+(?:\.\d{1,2})?\s*current balance/i.test(text));
    }

    _parseSettingsHtml(html, billingHtml = null) {
        const text = this._htmlToText(html);
        const lowerText = text.toLowerCase();
        const hasCloudUsage = lowerText.includes('cloud usage');
        const hasUsageWindow = lowerText.includes('session') && lowerText.includes('weekly');
        const hasLegacyBlock = hasCloudUsage && hasUsageWindow;
        const hasCreditBlock = this._hasCreditBlock(text);

        if (!hasLegacyBlock && !hasCreditBlock) {
            const looksLoggedOut = /\b(sign in|log in|login|create account)\b/i.test(text) || /href=["'][^"']*\/(signin|login)/i.test(html);
            const message = looksLoggedOut
                ? 'Ollama Cloud authentication failed. Please import fresh ollama.com cookies.'
                : 'Ollama Cloud usage block was not found on the settings page.';
            throw new UsageApiError(message, { statusCode: looksLoggedOut ? 401 : 0 });
        }

        const plan = this._extractPlan(text);
        const accountEmail = this._extractEmail(text) || 'Ollama Cloud';
        const loginMethod = plan ? `Ollama Cloud ${plan}` : 'Ollama Cloud';

        if (hasCreditBlock) {
            return this._parseCreditPool(html, text, billingHtml, accountEmail, loginMethod);
        }

        const session = this._extractWindow(html, text, 'session', 0);
        const weekly = this._extractWindow(html, text, 'weekly', 7 * 24 * 3600);

        if (!session && !weekly) {
            throw new UsageApiError('Ollama Cloud usage block was found, but quota percentages could not be parsed.');
        }

        return {
            labels: ['Session', 'Weekly'],
            usage: {
                accountEmail,
                loginMethod,
                updatedAt: new Date().toISOString(),
                primary: session,
                secondary: weekly,
                tertiary: null,
                quaternary: null,
            },
        };
    }

    /**
     * Parse the monthly credit-pool block (transparent per-token pricing).
     * No 5-hour or weekly limits exist on these plans; the pool refreshes monthly.
     * Returns a single tier so the extension renders a bar with reset and pace rows,
     * just like other windowed providers.
     */
    _parseCreditPool(html, text, billingHtml, accountEmail, loginMethod) {
        const poolMatch = text.match(/monthly usage\s*\$([\d,]+(?:\.\d{1,2})?)\s*of\s*\$([\d,]+(?:\.\d{1,2})?)\s*used/i);
        const used = poolMatch ? this._parseAmount(poolMatch[1]) : null;
        const limit = poolMatch ? this._parseAmount(poolMatch[2]) : null;

        if (used === null || limit === null || limit <= 0) {
            throw new UsageApiError('Ollama Cloud credit block was found, but usage amounts could not be parsed.');
        }

        const balanceMatch = text.match(/\$([\d,]+(?:\.\d{1,2})?)\s*current balance/i);
        const balance = balanceMatch ? this._parseAmount(balanceMatch[1]) : null;

        let billingPlan = '';
        let resetDate = null;
        if (billingHtml) {
            const info = this._extractBillingInfo(this._htmlToText(billingHtml));
            billingPlan = info.plan;
            resetDate = info.resetDate;
        }

        let resetAfterSeconds = 0;
        let windowSeconds = 30 * 24 * 3600;
        let resetLabel = '';
        if (resetDate) {
            resetAfterSeconds = Math.max(0, Math.round((resetDate.getTime() - Date.now()) / 1000));
            windowSeconds = this._monthSeconds(resetDate);
            resetLabel = `Resets ${resetDate.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
        } else {
            const monthlyChunk = this._chunkAround(html, /monthly usage/i, 2000);
            const monthlyText = this._chunkAround(text, /monthly usage/i, 600);
            resetAfterSeconds = this._extractResetAfterSeconds(monthlyChunk, monthlyText);
            resetLabel = this._extractResetText(monthlyText);
        }

        const method = billingPlan ? `Ollama Cloud ${billingPlan}` : loginMethod;
        const label = balance !== null && balance > 0
            ? `Monthly usage (+$${balance.toFixed(2)} credits)`
            : 'Monthly usage';
        const amounts = `$${used.toFixed(2)} / $${limit.toFixed(2)}`;

        return {
            labels: [label],
            usage: {
                accountEmail,
                loginMethod: method,
                updatedAt: new Date().toISOString(),
                primary: {
                    usedPercent: (used / limit) * 100,
                    windowSeconds,
                    resetAfterSeconds,
                    resetDescription: resetLabel ? `${amounts} · ${resetLabel}` : amounts,
                },
                secondary: null,
                tertiary: null,
                quaternary: null,
            },
        };
    }

    /**
     * Extract plan and renewal date from the billing page text.
     * Looks for "Your subscription renews on <date>".
     */
    _extractBillingInfo(billingText) {
        const planMatch = billingText.match(/(Pro|Max|Team|Free)\s+your subscription renews on/i);
        const dateMatch = billingText.match(/your subscription renews on\s+([A-Za-z]+\s+\d{1,2}(?:\s*,?\s*\d{4})?)/i);

        let resetDate = null;
        if (dateMatch) {
            resetDate = this._parseRenewalDate(dateMatch[1]);
        }

        return {
            plan: planMatch ? planMatch[1] : '',
            resetDate,
        };
    }

    /**
     * Parse a renewal date like "October 21, 2026" or "October 21".
     * Without a year, assume the next upcoming occurrence.
     */
    _parseRenewalDate(value) {
        const cleaned = value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        let parsed = Date.parse(cleaned);
        if (!isNaN(parsed)) return new Date(parsed);

        const now = new Date();
        parsed = Date.parse(`${cleaned} ${now.getFullYear()}`);
        if (isNaN(parsed)) return null;

        const date = new Date(parsed);
        if (date.getTime() < now.getTime()) {
            date.setFullYear(date.getFullYear() + 1);
        }
        return date;
    }

    /**
     * Seconds in the billing cycle ending at the given reset date
     * (same calendar day one month earlier; robust across month lengths).
     */
    _monthSeconds(resetDate) {
        const start = new Date(resetDate.getTime());
        start.setMonth(start.getMonth() - 1);
        return Math.max(7 * 24 * 3600, Math.round((resetDate.getTime() - start.getTime()) / 1000));
    }

    /**
     * Parse a dollar amount like "1,234.56" into a float.
     */
    _parseAmount(value) {
        const parsed = parseFloat(String(value).replace(/,/g, ''));
        return isNaN(parsed) ? null : parsed;
    }

    /**
     * Extract a single usage window (session or weekly) from the HTML.
     */
    _extractWindow(html, text, label, fallbackWindowSeconds) {
        const labelRegex = new RegExp(`\\b${label}\\b`, 'gi');
        const matches = [...text.matchAll(labelRegex)];
        if (matches.length === 0) return null;

        // Try each occurrence, preferring the one whose nearest percent
        // is closest after the label. This handles pages where "session"
        // and "weekly" appear close together.
        let best = null;
        for (const m of matches) {
            const idx = m.index;
            const textAfter = text.slice(idx, idx + 600);
            const htmlAfter = html.slice(
                Math.max(0, idx - 500),
                idx + 2000
            );
            const pct = this._extractPercent(textAfter) ??
                this._extractPercent(htmlAfter);
            if (pct !== null) {
                const pctMatch = textAfter.match(/\d+(?:\.\d+)?\s*%/);
                const distance = pctMatch ? pctMatch.index : 999;
                if (best === null || distance < best.distance) {
                    best = { percent: pct, distance, idx, textAfter, htmlAfter };
                }
            }
        }

        if (best === null) {
            const textChunk = this._chunkAround(text, labelRegex, 600);
            const htmlChunk = this._chunkAround(html, labelRegex, 2000);
            const percent = this._extractPercent(textChunk) ??
                this._extractPercent(htmlChunk);
            if (percent === null) return null;
            best = { percent, distance: 999, idx: matches[0].index, textAfter: textChunk, htmlAfter: htmlChunk };
        }

        const windowSeconds = this._extractWindowSeconds(
            text.slice(best.idx, best.idx + 600),
            fallbackWindowSeconds
        );
        const resetAfterSeconds = this._extractResetAfterSeconds(
            best.htmlAfter,
            best.textAfter
        );
        const resetDescription = resetAfterSeconds
            ? formatResetDescription(resetAfterSeconds, windowSeconds)
            : this._extractResetText(best.textAfter);

        return {
            usedPercent: best.percent,
            windowSeconds,
            resetDescription,
        };
    }

    /**
     * Strip HTML tags and decode entities to plain text.
     * Strips HTML tags and decodes entities into plain text.
     */
    _htmlToText(html) {
        return this._decodeHtmlEntities(html
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim());
    }

    /**
     * Decode common HTML entities.
     * Decodifica entidades HTML comunes.
     */
    _decodeHtmlEntities(value) {
        return value
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)));
    }

    /**
     * Extract a chunk of text around a regex match.
     */
    _chunkAround(value, regex, radius) {
        regex.lastIndex = 0;
        const match = regex.exec(value);
        if (!match) return '';

        const start = Math.max(0, match.index - radius);
        const end = Math.min(value.length, match.index + radius);
        return value.slice(start, end);
    }

    /**
     * Extract the first valid percentage from a text chunk.
     */
    _extractPercent(chunk) {
        const patterns = [
            /(\d+(?:\.\d+)?)\s*%/gi,
            /aria-valuenow=["'](\d+(?:\.\d+)?)["']/gi,
            /width\s*:\s*(\d+(?:\.\d+)?)%/gi,
            /(?:used|usage|percent|percentage)["'\s:=]+(\d+(?:\.\d+)?)/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(chunk)) !== null) {
                const value = parseFloat(match[1]);
                if (!isNaN(value) && value >= 0 && value <= 100) {
                    return value;
                }
            }
        }

        return null;
    }

    /**
     * Extract the window duration in seconds from text.
     */
    _extractWindowSeconds(chunk, fallbackWindowSeconds) {
        const hourMatch = chunk.match(/(\d+)\s*(?:-|\s)?\s*hour\s+(?:limit|window|session)/i) ||
            chunk.match(/(?:limit|window|session)[^\d]{0,30}(\d+)\s*(?:-|\s)?\s*hour/i);
        if (hourMatch) return parseInt(hourMatch[1], 10) * 3600;

        if (fallbackWindowSeconds) return fallbackWindowSeconds;
        if (/\bweekly\b/i.test(chunk)) return 7 * 24 * 3600;
        return 0;
    }

    /**
     * Extract reset-after seconds from data-time attributes or relative text.
     */
    _extractResetAfterSeconds(htmlChunk, textChunk) {
        const dataTimeRegex = /data-time=["']([^"']+)["']/gi;
        let match;
        while ((match = dataTimeRegex.exec(htmlChunk)) !== null) {
            const seconds = this._secondsUntil(match[1]);
            if (seconds > 0) return seconds;
        }

        return this._parseRelativeResetSeconds(textChunk);
    }

    /**
     * Convert a timestamp or date string to seconds until now.
     */
    _secondsUntil(value) {
        let timestamp = NaN;
        if (/^\d+$/.test(value)) {
            const numeric = parseInt(value, 10);
            timestamp = numeric > 100000000000 ? numeric : numeric * 1000;
        } else {
            timestamp = Date.parse(value);
        }

        if (isNaN(timestamp)) return 0;
        return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
    }

    /**
     * Parse relative reset text like "resets in 2 hours".
     */
    _parseRelativeResetSeconds(chunk) {
        const resetMatch = chunk.match(/(?:reset|refresh)[^\.]*?\bin\s+([^\.]+)/i);
        if (!resetMatch) return 0;

        const text = resetMatch[1];
        let seconds = 0;
        const weeks = text.match(/(\d+)\s*w(?:eek)?s?/i);
        const days = text.match(/(\d+)\s*d(?:ay)?s?/i);
        const hours = text.match(/(\d+)\s*h(?:our)?s?/i);
        const minutes = text.match(/(\d+)\s*m(?:in(?:ute)?)?s?/i);
        if (weeks) seconds += parseInt(weeks[1], 10) * 7 * 24 * 3600;
        if (days) seconds += parseInt(days[1], 10) * 24 * 3600;
        if (hours) seconds += parseInt(hours[1], 10) * 3600;
        if (minutes) seconds += parseInt(minutes[1], 10) * 60;
        return seconds;
    }

    /**
     * Extract a reset description text from a chunk.
     */
    _extractResetText(chunk) {
        const match = chunk.match(/((?:reset|refresh)[^\.]{0,120})/i);
        return match ? match[1].trim() : '';
    }

    /**
     * Extract the plan name from text.
     */
    _extractPlan(text) {
        const planMatch = text.match(/(?:current\s+)?plan\s*:?\s*(Free|Basic|Pro|Premium|Team|Business|Enterprise)/i) ||
            text.match(/\b(Free|Basic|Pro|Premium|Team|Business|Enterprise)\s+(?:plan|tier)\b/i);
        return planMatch ? planMatch[1] : '';
    }

    /**
     * Extract an email address from text.
     */
    _extractEmail(text) {
        const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
        return emailMatch ? emailMatch[0] : '';
    }
}
