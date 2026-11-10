// Pure parsing of `codexbar cost --format json` for the local cost summary.
// No gi:// imports, so it can be tested outside the Shell.

/**
 * @param {number} value
 * @param {string} currency ISO code.
 * @returns {string} e.g. "$0.04"
 */
export function formatMoney(value, currency = "USD") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const symbol = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }[currency];
  const abs = Math.abs(n);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  const sign = n < 0 ? "-" : "";
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`;
}

/**
 * @param {number} value
 * @returns {string} e.g. "15K", "1.2M"
 */
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Parse the CLI payload into per-provider cost rows.
 * `codexbar cost` only supports a subset of providers, so the payload can be
 * a mix of entries and per-provider error objects. Entries with no numbers are
 * dropped; an all-error payload yields null so the caller hides the section.
 *
 * @param {unknown} payload Parsed JSON from `codexbar cost --format json`.
 * @returns {{providers: Array<object>}|null}
 */
export function parseCostPayload(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const providers = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || entry.error) continue;
    const totalCost = Number(entry.totals?.totalCost);
    const totalTokens = Number(entry.totals?.totalTokens);
    const todayCost = Number(entry.sessionCostUSD);
    const todayTokens = Number(entry.sessionTokens);
    const periodCost = Number(entry.last30DaysCostUSD);
    const periodTokens = Number(entry.last30DaysTokens);
    const numbers = [
      totalCost,
      totalTokens,
      todayCost,
      todayTokens,
      periodCost,
      periodTokens,
    ].filter(Number.isFinite);
    if (numbers.length === 0 || numbers.every((value) => value === 0))
      continue;

    providers.push({
      id: entry.provider,
      currency: entry.currencyCode || "USD",
      cost: Number.isFinite(totalCost) ? totalCost : 0,
      tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
      todayCost: Number.isFinite(todayCost) ? todayCost : 0,
      todayTokens: Number.isFinite(todayTokens) ? todayTokens : 0,
      periodCost: Number.isFinite(periodCost) ? periodCost : 0,
      periodTokens: Number.isFinite(periodTokens) ? periodTokens : 0,
      periodLabel: entry.historyLabel || "",
    });
  }

  return providers.length > 0 ? { providers } : null;
}
