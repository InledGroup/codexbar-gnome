
// Provider connection sources.
//
// codexbar-cli exposes --source <auto|web|cli|oauth|api>. "Direct API" is not
// one of them: it's this extension talking to the provider itself with a
// cookie from the keyring, so it sits alongside the CLI sources as its own
// choice rather than being a source the CLI understands.
//
// Kept free of gi:// imports so it can be unit tested.

export const DIRECT_API = "direct-api";
export const CLI_SOURCES = ["auto", "web", "cli", "oauth", "api"];

/**
 * Build the codexbar-cli invocation for a provider and source.
 * @param {string} cliId Provider id as codexbar-cli knows it.
 * @param {string} source One of CLI_SOURCES.
 * @returns {string}
 */
export const buildCliCommand = (cliId, source) =>
  `codexbar --provider ${cliId} --source ${source} --format json`;

// Matches only commands of exactly the shape buildCliCommand produces, so a
// hand-written command carrying extra flags (--account, --all-accounts) is
// left alone. Tolerates an absolute binary path and the optional `usage`
// subcommand, since both forms work and users have both saved.
const GENERATED_COMMAND_RE =
  /^\s*(?:\S*codexbar)(?:\s+usage)?\s+--provider\s+(\S+)\s+--source\s+(\S+)\s+--format\s+json\s*$/;

/**
 * Parse a command back into provider id and source.
 * @param {string} command
 * @returns {{cliId: string, source: string}|null} Null if not one of ours.
 */
export function parseGeneratedCommand(command) {
  const match = GENERATED_COMMAND_RE.exec(command || "");
  if (!match) return null;
  const [, cliId, source] = match;
  return CLI_SOURCES.includes(source) ? { cliId, source } : null;
}

/**
 * True for the synthetic ids the "Add Custom Provider" dialog mints.
 * @param {unknown} id
 * @returns {boolean}
 */
export const isCustomId = (id) =>
  typeof id === "string" && id.startsWith("custom-");

/**
 * Fold hand-rolled custom providers back onto the predefined entry they
 * duplicate.
 *
 * Before the source selector existed, reaching a source the predefined row
 * didn't offer (OAuth, say) meant adding a custom provider by hand. Those
 * carry a synthetic `custom-<timestamp>` id, and the id is what resolves the
 * tab logo and the keyring entry - so they render without a logo and their
 * secret is orphaned if the row is ever recreated.
 *
 * Only exact generated commands are adopted, and only when the predefined
 * provider isn't already configured, so a deliberate second account or a
 * genuinely custom command survives untouched.
 *
 * @param {Array<object>} providers Saved provider list.
 * @param {Array<{id: string, name: string}>} predefined Known providers.
 * @returns {Array<object>} New list; input is not mutated.
 */
export function adoptCustomProviders(providers, predefined) {
  if (!Array.isArray(providers)) return [];

  const claimed = new Set(
    providers.filter((p) => p && !isCustomId(p.id)).map((p) => p.id),
  );

  return providers.map((provider) => {
    if (!provider || !isCustomId(provider.id)) return provider;

    const parsed = parseGeneratedCommand(provider.command);
    if (!parsed) return provider;

    const match = predefined.find((p) => p.id === parsed.cliId);
    if (!match || claimed.has(match.id)) return provider;

    claimed.add(match.id);
    return {
      id: match.id,
      name: match.name,
      command: provider.command,
      useApi: false,
      source: parsed.source,
    };
  });
}
