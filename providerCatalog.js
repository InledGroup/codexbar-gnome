// Pure helpers for discovering the providers enabled in the codexbar CLI.
//
// Kept free of gi:// imports so the parsing and merge rules can be tested with
// a bare `gjs -m`.

import { buildCliCommand, DIRECT_API } from "./providerSources.js";

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Parse `codexbar config providers --format json` into the enabled providers.
 *
 * The CLI emits one object per known provider, including disabled ones. Only
 * enabled entries are useful here: a disabled provider cannot be queried.
 *
 * @param {unknown} raw Parsed JSON, or the raw JSON text.
 * @returns {Array<{id: string, name: string}>}
 */
export function parseConfigProviders(raw) {
  let payload = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      return [];
    }
  }

  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.providers)
      ? payload.providers
      : [];

  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.enabled !== true) continue;
    const id = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!PROVIDER_ID_RE.test(id) || seen.has(id)) continue;

    const rawName = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
    result.push({
      id,
      name: rawName ? rawName.slice(0, 120) : id,
    });
    seen.add(id);
  }
  return result;
}

/**
 * Add CLI-enabled providers that are not configured yet.
 *
 * Saved entries are never rewritten or removed: a user may have hand-edited a
 * command, pinned a workspace or chosen Direct API. Discovered entries are
 * marked so Preferences can remember a removal instead of adding them back on
 * the next scan.
 *
 * @param {Array<object>} saved Providers already stored in settings.
 * @param {Array<{id: string, name: string}>} discovered Enabled CLI providers.
 * @param {Array<{id: string, name: string, defaultCommand?: string}>} predefined
 * @param {string[]} dismissed Provider ids the user removed from Preferences.
 * @returns {Array<object>} New list; the input is not mutated.
 */
export function mergeDiscoveredProviders(
  saved,
  discovered,
  predefined = [],
  dismissed = [],
) {
  const providers = Array.isArray(saved)
    ? saved.filter((provider) => provider && typeof provider.id === "string")
    : [];
  const known = new Set(providers.map((provider) => provider.id));
  const ignored = new Set(
    Array.isArray(dismissed)
      ? dismissed.filter((id) => typeof id === "string")
      : [],
  );

  for (const entry of Array.isArray(discovered) ? discovered : []) {
    if (!entry || typeof entry.id !== "string" || known.has(entry.id)) continue;
    if (ignored.has(entry.id)) continue;

    const info = predefined.find((provider) => provider.id === entry.id);
    // Some providers (notably Codex on Linux) have no working CLI source but
    // do have this extension's direct adapter. Add them in that mode instead
    // of generating a command that can only fail.
    const direct = Boolean(info?.supportsDirectApi);
    providers.push({
      id: entry.id,
      name: info?.name || entry.name || entry.id,
      command: direct
        ? ""
        : info?.defaultCommand || buildCliCommand(entry.id, "auto"),
      useApi: direct,
      source: direct ? DIRECT_API : "auto",
      autoDiscovered: true,
    });
    known.add(entry.id);
  }

  return providers;
}
