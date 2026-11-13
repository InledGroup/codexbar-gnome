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
      ...provider,
      id: match.id,
      name: match.name,
      command: provider.command,
      useApi: false,
      source: parsed.source,
    };
  });
}

/** Resolve preference rows without changing their stored configuration. */
export function resolveProviderRows(providers, predefined) {
  const ids = new Set();
  const rows = predefined.map(info => {
    const activeData = providers.find(p => p.id === info.id) || null;
    if (activeData) {
      ids.add(activeData.id);
    }
    return {info, activeData};
  });
  for (const provider of providers) {
    if (!ids.has(provider.id)) {
      rows.push({info: {id: provider.id, name: provider.name,
        useApi: provider.useApi || false, defaultCommand: provider.command}, activeData: provider});
    }
  }
  return rows;
}

// Providers this extension can query itself with a keyring cookie.
const DIRECT_PROVIDERS = [
  {
    id: "codex",
    name: "Codex",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
    detectCommands: ["codex"],
  },
  {
    id: "ollama",
    name: "Ollama Cloud",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
    detectCommands: ["ollama"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: buildCliCommand("opencode", "auto"),
    detectCommands: ["opencode"],
  },
  {
    id: "opencodego",
    name: "OpenCode Go",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: buildCliCommand("opencodego", "auto"),
    detectCommands: ["opencode"],
  },
];

// Providers exposed by codexbar-cli without requiring a browser-cookie-only
// path. Each row keeps its preferred non-cookie source; users can still pick
// another source in Preferences when their setup needs it.
//
// `detectCommands` is used by the Preferences scanner: if the provider's own
// CLI is installed, the extension enables that provider in codexbar instead of
// waiting for it to be configured by hand.
const CLI_PROVIDER_DEFS = [
  { id: "claude", name: "Claude", source: "cli", detectCommands: ["claude"] },
  { id: "gemini", name: "Gemini", source: "api", detectCommands: ["gemini"] },
  { id: "antigravity", name: "Antigravity", source: "cli", detectCommands: ["agy"] },
  { id: "copilot", name: "Copilot", source: "api" },
  { id: "openrouter", name: "OpenRouter", source: "api" },
  { id: "deepseek", name: "DeepSeek", source: "api" },
  { id: "openai", name: "OpenAI", source: "api" },
  { id: "azureopenai", name: "Azure OpenAI", source: "api" },
  { id: "clinepass", name: "ClinePass", source: "api", detectCommands: ["cline"] },
  { id: "alibaba", name: "Alibaba", source: "api" },
  { id: "alibabatokenplan", name: "Alibaba Token Plan", source: "cli", detectCommands: ["bl"] },
  { id: "factory", name: "Droid", source: "api", detectCommands: ["droid"] },
  { id: "fireworks", name: "Fireworks", source: "api" },
  { id: "zai", name: "z.ai / GLM", source: "api" },
  { id: "minimax", name: "MiniMax", source: "api" },
  { id: "kimi", name: "Kimi Code", source: "api" },
  { id: "kilo", name: "Kilo", source: "api", detectCommands: ["kilo"] },
  { id: "kiro", name: "Kiro", source: "cli", detectCommands: ["kiro-cli"] },
  { id: "vertexai", name: "Vertex AI", source: "oauth" },
  { id: "augment", name: "Augment", source: "cli", detectCommands: ["auggie"] },
  {
    id: "jetbrains",
    name: "JetBrains AI",
    source: "auto",
    detectPaths: [".config/JetBrains", ".config/Google"],
  },
  { id: "moonshot", name: "Moonshot / Kimi Open Platform", source: "api" },
  { id: "amp", name: "Amp", source: "cli", detectCommands: ["amp"] },
  { id: "synthetic", name: "Synthetic", source: "api" },
  { id: "elevenlabs", name: "ElevenLabs", source: "api" },
  { id: "warp", name: "Warp", source: "api" },
  { id: "windsurf", name: "Windsurf", source: "auto", detectCommands: ["windsurf"] },
  { id: "doubao", name: "Doubao", source: "api" },
  { id: "deepinfra", name: "DeepInfra", source: "api" },
  { id: "codebuff", name: "Codebuff", source: "api", detectCommands: ["codebuff"] },
  { id: "venice", name: "Venice", source: "api" },
  { id: "commandcode", name: "Command Code", source: "api" },
  { id: "bedrock", name: "AWS Bedrock", source: "api" },
  { id: "grok", name: "Grok", source: "cli", detectCommands: ["grok"] },
  { id: "groq", name: "Groq", source: "api" },
  { id: "llmproxy", name: "LLM Proxy", source: "api" },
  { id: "litellm", name: "LiteLLM", source: "api" },
  { id: "bifrost", name: "Bifrost", source: "api" },
  { id: "aixy", name: "Aixy", source: "api" },
  { id: "deepgram", name: "Deepgram", source: "api" },
  { id: "poe", name: "Poe", source: "api" },
  { id: "chutes", name: "Chutes", source: "api" },
  { id: "neuralwatt", name: "Neuralwatt", source: "api" },
  { id: "clawrouter", name: "ClawRouter", source: "api" },
  { id: "sub2api", name: "sub2api", source: "api" },
  { id: "wayfinder", name: "Wayfinder", source: "auto" },
  { id: "zenmux", name: "ZenMux", source: "api" },
  { id: "aiand", name: "ai&", source: "api" },
  { id: "xai", name: "xAI", source: "api" },
  { id: "ibmbob", name: "IBM Bob", source: "api" },
  { id: "nous", name: "Nous Portal", source: "api", detectCommands: ["hermes"] },
  { id: "muse", name: "Muse Code", source: "oauth", detectCommands: ["muse"] },
  {
    id: "coderabbit",
    name: "CodeRabbit",
    source: "cli",
    detectCommands: ["coderabbit"],
  },
  { id: "huggingface", name: "Hugging Face", source: "api" },
  { id: "pi", name: "Pi", source: "auto", detectCommands: ["pi"] },
  { id: "v0", name: "v0", source: "api" },
  { id: "hyper", name: "Charm Hyper", source: "auto", detectCommands: ["hyper"] },
  { id: "gitkraken", name: "GitKraken AI", source: "api", detectCommands: ["gk"] },
  { id: "devpass", name: "DevPass", source: "api" },
  { id: "atlascloud", name: "Atlas Cloud", source: "api" },
  { id: "vercel", name: "Vercel AI Gateway", source: "api" },
  { id: "llmman", name: "llmman", source: "auto", detectCommands: ["llmman"] },
  { id: "xkiro", name: "xKiro", source: "api" },
  { id: "tavily", name: "Tavily", source: "api" },
  { id: "linkup", name: "Linkup", source: "api" },
  { id: "exa", name: "Exa", source: "api" },
  { id: "cosmic", name: "Cosmic AI", source: "api" },
  { id: "aerostack", name: "Aerostack", source: "api" },
  { id: "sailresearch", name: "Sail Research", source: "api" },
  { id: "sofya", name: "Sofya", source: "api" },
];

export const PREDEFINED_PROVIDERS = [
  ...DIRECT_PROVIDERS,
  ...CLI_PROVIDER_DEFS.map(({ id, name, source, detectCommands, detectPaths }) => ({
    id,
    name,
    useApi: false,
    defaultCommand: buildCliCommand(id, source),
    ...(detectCommands ? { detectCommands } : {}),
    ...(detectPaths ? { detectPaths } : {}),
  })),
];
