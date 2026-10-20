import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import {tr as _} from '../localize.js';

// Console contract documented by CodexBar v0.78.0, docs/opencode.md.
// Micro-cents are integers; USD = micro-cents / 100,000,000.
function microCents(raw, signed = false) {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    if (!(signed ? /^-?\d+$/ : /^\d+$/).test(String(raw))) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
}

class ConsoleError extends Error {
    constructor(message, statusCode = 0) {
        super(message);
        this.name = 'OpenCodeConsoleError';
        this.statusCode = statusCode;
    }
}

const invalidPayload = () => new ConsoleError(_('Invalid OpenCode Console usage data.'));
const noSubscription = status => status === null || status?.access === null;

/** Convert Console JSON into the extension's existing usage contract. */
export function normalizeOpenCodeConsole({providerId = 'opencodego', goStatus, billingStatus = null,
    usageSummary = null, now = Date.now()}) {
    const usage = {updatedAt: new Date(now).toISOString(), primary: null, secondary: null, tertiary: null};
    const labels = [_('5-Hour Window'), _('Weekly Window'), _('Monthly Window')];
    if (noSubscription(goStatus)) {
        usage.subscriptionStatus = 'none';
    } else {
        const access = goStatus?.access;
        if (!access?.meters || typeof access.meters !== 'object') throw invalidPayload();
        const fields = [['fiveHour', 'primary', 18000], ['week', 'secondary', 604800], ['month', 'tertiary', 2592000]];
        let reported = false;
        for (const [name, tier, seconds] of fields) {
            const meter = access.meters[name];
            if (meter === undefined || meter === null) continue;
            const used = microCents(meter.usedMicroCents);
            const limit = microCents(meter.limitMicroCents);
            if (used === null || limit === null) throw invalidPayload();
            reported = true;
            if (limit === 0) continue;
            const reset = Date.parse(meter.resetsAt ?? (name === 'month' ? access.endsAt : ''));
            const resetAfterSeconds = Number.isFinite(reset) ? Math.max(0, Math.ceil((reset - now) / 1000)) : null;
            usage[tier] = {usedPercent: Math.min(100, 100 * used / limit), windowSeconds: seconds,
                resetAfterSeconds, resetDescription: ''};
        }
        if (!reported) throw invalidPayload();
    }
    if (billingStatus?.billingMode === 'prepaid' && billingStatus?.mode === 'pay-as-you-go') {
        const balance = microCents(billingStatus.balanceMicroCents, true);
        if (balance !== null) usage.balanceUSD = balance / 100000000;
    }
    if (providerId === 'opencode' && usageSummary !== null) {
        const spend = microCents(usageSummary?.totalCostMicroCents);
        if (spend === null) throw invalidPayload();
        usage.providerCost = {used: spend / 100000000, limit: 0, currencyCode: 'USD', period: _('Last 30 days')};
    }
    return {usage, labels};
}

/** Linux-compatible authenticated reads from the current OpenCode Console. */
export class OpenCodeConsoleFetcher {
    constructor(session) {
        this._session = session;
    }

    async fetch(cookieHeader, {providerId = 'opencodego', workspaceId = '', cancellable = null} = {}) {
        this._checkCancelled(cancellable);
        // This integration uses the Console session, not legacy server-function cookies.
        if (!/(?:^|;\s*)__Host-console_session=[^;\s]+/.test(cookieHeader || '') || /[\r\n]/.test(cookieHeader))
            throw new ConsoleError(_('Sign in to OpenCode Console and import its session cookies.'));
        workspaceId = workspaceId.trim();
        if (workspaceId && !/^(?:org|wrk)_[A-Za-z0-9_-]+$/.test(workspaceId))
            throw new ConsoleError(_('Enter a valid OpenCode workspace ID (org_… or wrk_…).'));
        if (!workspaceId) {
            const orgs = await this._get('/console/api/orgs', cookieHeader, null, cancellable);
            if (!Array.isArray(orgs) || !orgs.length) throw invalidPayload();
            if (orgs.length !== 1)
                throw new ConsoleError(_('Multiple OpenCode workspaces found. Set the workspace ID in Preferences.'));
            workspaceId = orgs[0]?.id;
            if (typeof workspaceId !== 'string' || !/^(?:org|wrk)_[A-Za-z0-9_-]+$/.test(workspaceId)) throw invalidPayload();
        }
        const goStatus = await this._get('/console/api/go/status', cookieHeader, workspaceId, cancellable);
        // Validate meters before treating billing as optional; malformed quota is not PAYG.
        normalizeOpenCodeConsole({providerId, goStatus});
        let billingStatus = null;
        let usageSummary = null;
        if (providerId === 'opencode' && noSubscription(goStatus)) {
            const org = await this._get('/console/api/orgs/current', cookieHeader, workspaceId, cancellable);
            if (org?.hasGoSubscription !== false)
                throw new ConsoleError(_('OpenCode subscription usage is unavailable.'));
            billingStatus = await this._get('/console/api/billing/status', cookieHeader, workspaceId, cancellable);
            if (billingStatus?.mode !== 'pay-as-you-go')
                throw new ConsoleError(_('This OpenCode billing mode is not supported.'));
            usageSummary = await this._get('/console/api/usage/summary?range=30d', cookieHeader, workspaceId, cancellable);
        } else {
            try {
                billingStatus = await this._get('/console/api/billing/status', cookieHeader, workspaceId, cancellable);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
                // A failed optional balance cannot erase successfully retrieved quota.
            }
        }
        this._checkCancelled(cancellable);
        return normalizeOpenCodeConsole({providerId, goStatus, billingStatus, usageSummary});
    }

    _checkCancelled(cancellable) {
        if (cancellable?.is_cancelled())
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled');
    }

    async _get(path, cookie, workspaceId, cancellable) {
        this._checkCancelled(cancellable);
        const message = Soup.Message.new('GET', `https://opencode.ai${path}`);
        // Never forward a session cookie through a redirect to another host.
        message.set_flags(Soup.MessageFlags.NO_REDIRECT);
        const headers = message.get_request_headers();
        headers.append('Accept', 'application/json');
        headers.append('User-Agent', 'CodexBar-GNOME');
        headers.append('Cookie', cookie);
        if (workspaceId) headers.append('x-org-id', workspaceId);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
                try { resolve(session.send_and_read_finish(result)); } catch (e) { reject(e); }
            });
        });
        this._checkCancelled(cancellable);
        const status = message.get_status();
        if (status === 401)
            throw new ConsoleError(_('OpenCode session expired. Sign in to OpenCode Console and import cookies again.'), status);
        if (status !== 200)
            throw new ConsoleError(_('OpenCode Console request failed (HTTP %s).').replace('%s', String(status)), status);
        try {
            return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.get_data()));
        } catch {
            throw invalidPayload();
        }
    }
}
