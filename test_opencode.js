import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const module = await import('./adapters/OpenCodeConsoleFetcher.js').catch(() => ({}));
const {normalizeOpenCodeConsole: normalize, OpenCodeConsoleFetcher} = module;
function assert(condition, message) {
    if (!condition) throw new Error(message);
}
assert(typeof normalize === 'function', 'OpenCode Console normalizer must exist');
const now = Date.parse('2026-10-20T00:00:00Z');
const goStatus = {access: {endsAt: '2026-11-20T00:00:00Z', meters: {
    fiveHour: {usedMicroCents: '25', limitMicroCents: '100'},
    week: {usedMicroCents: '50', limitMicroCents: '100', resetsAt: '2026-10-21T00:00:00Z'},
    month: {usedMicroCents: '75', limitMicroCents: '100', resetsAt: null},
}}};
const billingStatus = {billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: '7363000000'};
const quota = normalize({providerId: 'opencodego', goStatus, billingStatus, now});
assert(quota.usage.primary.usedPercent === 25, 'five-hour percentage');
assert(quota.usage.secondary.usedPercent === 50, 'weekly percentage');
assert(quota.usage.tertiary.usedPercent === 75, 'monthly percentage');
assert(quota.usage.primary.resetAfterSeconds === null, 'unknown reset remains unknown');
assert(quota.usage.tertiary.resetAfterSeconds === 31 * 86400, 'monthly reset uses subscription end');
assert(quota.usage.balanceUSD === 73.63, 'balance micro-cent scale');
assert(quota.usage.providerCost === undefined, 'balance is not spending');
for (const [raw, amount] of [['0', 0], ['-100000000', -1]]) {
    const result = normalize({providerId: 'opencodego', goStatus, billingStatus: {...billingStatus, balanceMicroCents: raw}, now});
    assert(result.usage.balanceUSD === amount, 'signed and zero balances preserved');
}
const clone = obj => JSON.parse(JSON.stringify(obj));
for (const invalid of [null, true, 'invalid', '-1', '1.5', '9007199254740992']) {
    const bad = clone(goStatus);
    bad.access.meters.fiveHour.usedMicroCents = invalid;
    let failed = false;
    try { normalize({goStatus: bad, now}); } catch { failed = true; }
    assert(failed, `malformed meter rejected: ${invalid}`);
}
const zero = clone(goStatus);
zero.access.meters.fiveHour.limitMicroCents = '0';
assert(normalize({goStatus: zero, now}).usage.primary === null, 'zero limit has no percentage');
const payg = normalize({providerId: 'opencode', goStatus: null, billingStatus,
    usageSummary: {totalCostMicroCents: '1234000000'}, now});
assert(payg.usage.providerCost.used === 12.34 && payg.usage.providerCost.limit === 0, 'PAYG spend without fake quota');
assert(payg.usage.providerCost.period === 'Last 30 days', 'rolling period label');
assert(payg.usage.balanceUSD === 73.63, 'PAYG separate balance');
assert(normalize({goStatus: null, billingStatus: {availableMicroCents: '999'}, now}).usage.balanceUSD === undefined,
    'available credit is not substituted for balance');

// Exercise real request construction, status handling and parsing with synthetic replies.
function transport(replies) {
    const calls = [];
    return {calls,
        send_and_read_async(message, _priority, cancellable, callback) {
            calls.push({path: message.get_uri().get_path() + (message.get_uri().get_query() ? '?' + message.get_uri().get_query() : ''),
                workspace: message.get_request_headers().get_one('x-org-id'),
                cookie: message.get_request_headers().get_one('Cookie'), cancellable});
            const reply = replies[calls.at(-1).path];
            assert(reply, `unexpected request ${calls.at(-1).path}`);
            message.get_status = () => reply.status || 200;
            callback(this, {body: reply.body === undefined ? JSON.stringify(reply.json) : reply.body, error: reply.error});
        },
        send_and_read_finish(result) {
            if (result.error) throw result.error;
            return new GLib.Bytes(new TextEncoder().encode(result.body));
        },
    };
}
const orgs = '/console/api/orgs';
const status = '/console/api/go/status';
const billing = '/console/api/billing/status';
const cookie = '__Host-console_session=synthetic-session';
const session = transport({[orgs]: {json: [{id: 'org_TEST'}]}, [status]: {json: goStatus}, [billing]: {json: billingStatus}});
const fetched = await new OpenCodeConsoleFetcher(session).fetch(cookie, {providerId: 'opencodego'});
assert(fetched.usage.primary.usedPercent === 25, 'fetch returns normalized meters');
assert(session.calls[0].workspace === null && session.calls.slice(1).every(c => c.workspace === 'org_TEST'), 'workspace header scoped');
assert(session.calls.every(c => c.cookie === cookie), 'session cookie forwarded');
const paygSession = transport({[status]: {json: null}, '/console/api/orgs/current': {json: {hasGoSubscription: false}},
    [billing]: {json: billingStatus}, '/console/api/usage/summary?range=30d': {json: {totalCostMicroCents: '1234000000'}}});
assert((await new OpenCodeConsoleFetcher(paygSession).fetch(cookie, {providerId: 'opencode', workspaceId: 'org_TEST'})).usage.providerCost.used === 12.34,
    'PAYG fetch checks subscription and requests rolling summary');
assert(paygSession.calls.every(c => c.workspace === 'org_TEST'), 'PAYG workspace remains pinned');
for (const code of [401, 403]) {
    const denied = transport({[status]: {status: code, json: {}}});
    let failure;
    try { await new OpenCodeConsoleFetcher(denied).fetch(cookie, {workspaceId: 'org_TEST'}); } catch (e) { failure = e; }
    assert(failure?.statusCode === code, `HTTP ${code} preserved`);
    assert(code !== 403 || !/sign in/i.test(failure.message), '403 not presented as signed out');
}
for (const reply of [{json: [{id: 'org_A'}, {id: 'org_B'}]}, {body: '<html>sign in</html>'}]) {
    const ambiguous = transport({[orgs]: reply});
    let failure;
    try { await new OpenCodeConsoleFetcher(ambiguous).fetch(cookie); } catch (e) { failure = e; }
    assert(failure && ambiguous.calls.length === 1, 'ambiguous workspace or non-JSON fails before fetching meters');
}
const optional = transport({[status]: {json: goStatus}, [billing]: {status: 500, json: {}}});
assert((await new OpenCodeConsoleFetcher(optional).fetch(cookie, {providerId: 'opencodego', workspaceId: 'org_TEST'})).usage.primary.usedPercent === 25,
    'optional billing failure preserves quota');
const absent = transport({[status]: {json: {access: null}}, [billing]: {json: billingStatus}});
assert((await new OpenCodeConsoleFetcher(absent).fetch(cookie, {providerId: 'opencodego', workspaceId: 'org_TEST'})).usage.subscriptionStatus === 'none', 'successful no subscription is explicit');
const cancel = new Gio.Cancellable();
cancel.cancel();
const cancelled = transport({});
let cancellation;
try { await new OpenCodeConsoleFetcher(cancelled).fetch(cookie, {cancellable: cancel}); } catch (e) { cancellation = e; }
assert(cancellation?.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED), 'cancellation propagated before request');
assert(cancelled.calls.length === 0, 'cancelled request does not start');
console.log('✓ OpenCode Console quota, money, workspace, transport and cancellation tests');

const {PREDEFINED_PROVIDERS, adoptCustomProviders, buildCliCommand, parseGeneratedCommand} = await import('./providerSources.js');
assert(Array.isArray(PREDEFINED_PROVIDERS), 'predefined catalog is available for testing');
for (const [id, name] of [['opencode', 'OpenCode'], ['opencodego', 'OpenCode Go']]) {
    const entry = PREDEFINED_PROVIDERS.find(p => p.id === id);
    assert(entry?.name === name && entry.useApi && entry.supportsDirectApi, `${id} is selectable with Direct API`);
    assert(parseGeneratedCommand(entry.defaultCommand)?.cliId === id, 'CLI default uses canonical ID');
    const migrated = adoptCustomProviders([{id: 'custom-1', name, command: buildCliCommand(id, 'auto'), showInPanel: true}], PREDEFINED_PROVIDERS);
    assert(migrated[0].id === id && migrated[0].showInPanel === true, 'migration preserves panel selection');
    const custom = [{id: 'custom-2', name: name + ' work', command: buildCliCommand(id, 'auto') + ' --account work'}];
    assert(adoptCustomProviders(custom, PREDEFINED_PROVIDERS)[0].id === 'custom-2', 'account-specific command remains custom');
    assert(adoptCustomProviders([{id, name}, ...custom], PREDEFINED_PROVIDERS)[1].id === 'custom-2', 'deliberate duplicate remains custom');
}
const {formatPanelText} = await import('./localize.js');
assert(formatPanelText({balanceUSD: 0}, 'remaining') === '$0.00', 'balance-only zero panel');
assert(formatPanelText({balanceUSD: -1}, 'remaining') === '$-1.00', 'balance-only signed panel');
assert(formatPanelText({balanceUSD: 73.63, providerCost: {used: 12.34, currencyCode: 'USD'}}, 'used') === '$12.34', 'PAYG panel shows labeled spend in used mode');
assert(formatPanelText({balanceUSD: 73.63, providerCost: {used: 12.34, currencyCode: 'USD'}}, 'remaining') === '$73.63', 'PAYG remaining mode shows balance');
console.log('✓ OpenCode catalog, migration and balance panel tests');
