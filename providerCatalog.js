// Pure helpers for discovering installed providers and merging them into the
// extension's settings.
//
// Kept free of gi:// imports so the parsing, detection and merge rules can be
// tested with a bare `gjs -m`.

import {
  buildCliCommand,
  DIRECT_API,
  parseGeneratedCommand,
} from "./providerSources.js";

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]*$/;

/**
 * Parse `codexbar config providers --format json` including disabled entries.
 *
 * The full catalog is useful because the CLI knows every provider ID it can
 * query, even before the user enables one. Preferences uses the enabled subset
 * for the automatic merge and the static catalog for browsing.
 *
 * @param {unknown} raw Parsed JSON, or the raw JSON text.
 * @returns {Array<{id: string, name: string, enabled: boolean}>}
 */
export function parseProviderCatalog(raw) {
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
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (!PROVIDER_ID_RE.test(id) || seen.has(id)) continue;

    const rawName = typeof entry.displayName === "string" ? entry.displayName.trim() : "";
    result.push({
      id,
      name: rawName ? rawName.slice(0, 120) : id,
      enabled: entry.enabled === true,
    });
    seen.add(id);
  }
  return result;
}

/**
 * Parse the enabled subset. Kept as a separate helper because callers that only
 * need "what can I query now" should not filter the full catalog themselves.
 *
 * @param {unknown} raw Parsed JSON, or the raw JSON text.
 * @returns {Array<{id: string, name: string}>}
 */
export function parseConfigProviders(raw) {
  return parseProviderCatalog(raw)
    .filter((entry) => entry.enabled)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * Find providers whose own CLI or local app is installed.
 *
 * The probes are injected so this stays testable without gi:// imports. The
 * caller decides what counts as a command/path; this function only applies the
 * declarative metadata from providerSources.js.
 *
 * @param {Array<object>} predefined Provider metadata.
 * @param {{hasCommand?: (name: string) => boolean, hasPath?: (path: string) => boolean}} probes
 * @returns {Array<{id: string, name: string}>}
 */
export function detectInstalledProviders(
  predefined,
  { hasCommand = () => false, hasPath = () => false } = {},
) {
  const found = [];
  const seen = new Set();
  for (const info of Array.isArray(predefined) ? predefined : []) {
    if (!info || typeof info.id !== "string" || seen.has(info.id)) continue;
    const commands = Array.isArray(info.detectCommands) ? info.detectCommands : [];
    const paths = Array.isArray(info.detectPaths) ? info.detectPaths : [];
    if (!commands.some((command) => hasCommand(command)) &&
        !paths.some((path) => hasPath(path))) {
      continue;
    }
    found.push({ id: info.id, name: info.name || info.id });
    seen.add(info.id);
  }
  return found;
}

/**
 * Add enabled or installed providers that are not configured yet.
 *
 * Saved entries are never rewritten or removed: a user may have hand-edited a
 * command, pinned a workspace or chosen Direct API. Discovered entries are
 * marked so Preferences can remember a removal instead of adding them back on
 * the next scan.
 *
 * @param {Array<object>} saved Providers already stored in settings.
 * @param {Array<{id: string, name: string}>} discovered Enabled or installed providers.
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
    const source = direct
      ? DIRECT_API
      : parseGeneratedCommand(info?.defaultCommand)?.source || "auto";
    providers.push({
      id: entry.id,
      name: info?.name || entry.name || entry.id,
      command: direct
        ? ""
        : info?.defaultCommand || buildCliCommand(entry.id, source),
      useApi: direct,
      source,
      autoDiscovered: true,
    });
    known.add(entry.id);
  }

  return providers;
}
