// Pure parsing of `codexbar usage --format json` into the shape the UI renders.
// No gi:// imports, so it unit-tests headless with gjs or node.

/**
 * Provider id (as the CLI spells it in output) to display name.
 * Output ids differ from --provider flag spelling in places, e.g. output
 * "azureopenai" vs flag "azure-openai", so key on the output form.
 */
export const PROVIDER_NAMES = {
  codex: "Codex",
  openai: "OpenAI",
  azureopenai: "Azure OpenAI",
  claude: "Claude",
  clinepass: "Cline Pass",
  cursor: "Cursor",
  opencode: "OpenCode",
  opencodego: "OpenCode Go",
  alibaba: "Alibaba",
  alibabatokenplan: "Alibaba Token Plan",
  qwencloud: "Qwen Cloud",
  factory: "Factory",
  fireworks: "Fireworks",
  gemini: "Gemini",
  antigravity: "Antigravity",
  copilot: "Copilot",
  devin: "Devin",
  zai: "Z.ai",
  minimax: "MiniMax",
  manus: "Manus",
  kimi: "Kimi",
  kilo: "Kilo",
  kiro: "Kiro",
  vertexai: "Vertex AI",
  augment: "Augment",
  jetbrains: "JetBrains",
  moonshot: "Moonshot",
  amp: "Amp",
  t3chat: "T3 Chat",
  langdock: "LangDock",
  ollama: "Ollama",
  synthetic: "Synthetic",
  openrouter: "OpenRouter",
  elevenlabs: "ElevenLabs",
  warp: "Warp",
  windsurf: "Windsurf",
  zed: "Zed",
  perplexity: "Perplexity",
  mimo: "MiMo",
  doubao: "Doubao",
  sakana: "Sakana",
  abacus: "Abacus",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  deepinfra: "DeepInfra",
  codebuff: "Codebuff",
  venice: "Venice",
  commandcode: "CommandCode",
  qoder: "Qoder",
  stepfun: "StepFun",
  bedrock: "Bedrock",
  grok: "Grok",
  groq: "Groq",
  litellm: "LiteLLM",
  poe: "Poe",
  muse: "Muse",
  coderabbit: "CodeRabbit",
  replicate: "Replicate",
  huggingface: "HuggingFace",
  raycast: "Raycast",
  pi: "Pi",
  v0: "v0",
};

/** Positional window keys the CLI emits. Order is display order. */
const WINDOW_KEYS = ["primary", "secondary", "tertiary", "quaternary"];

// macOS calls the 5-hour window "Session". Everything else passes through, so
// "Weekly" and "Monthly" from the CLI read as the macOS app shows them.
const SESSION_LABELS = new Set(["5-hour", "5 hour", "5h", "session"]);

/**
 * @param {string} raw Label as the CLI sent it.
 * @returns {string}
 */
function displayLabel(raw) {
  if (!raw) return "Usage";
  return SESSION_LABELS.has(raw.toLowerCase()) ? "Session" : raw;
}

/**
 * @param {unknown} value
 * @returns {number|null} Clamped whole percent, or null if not a number.
 */
function percent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/**
 * A window is a spend meter only if the CLI says how long it lasts or when it
 * resets. Balance windows (DeepSeek, OpenRouter) have neither, and must not be
 * drawn as a 0% bar.
 */
function isMeterWindow(win) {
  if (!win || typeof win !== "object") return false;
  return Boolean(win.windowMinutes || win.windowSeconds || win.resetsAt);
}

function parseDetails(details) {
  if (!Array.isArray(details)) return [];
  return details.slice(0, 8).flatMap((section) => {
    if (!section || typeof section !== "object") return [];
    const rows = (Array.isArray(section.rows) ? section.rows : []).slice(0, 20).flatMap((row) => {
      if (!row || typeof row.label !== "string" || typeof row.value !== "string") return [];
      return [{ label: row.label.slice(0, 120), value: row.value.slice(0, 240),
        secondaryValue: typeof row.secondaryValue === "string" ? row.secondaryValue.slice(0, 240) : "" }];
    });
    let chart = null;
    if (section.chart?.kind === "bars" && Array.isArray(section.chart.points) && section.chart.points.length <= 120) {
      const points = section.chart.points.flatMap((point) =>
        point && typeof point.label === "string" && Number.isFinite(point.value) && point.value >= 0
          ? [{ label: point.label.slice(0, 100), value: point.value }]
          : [],
      );
      if (points.length) chart = { title: String(section.chart.title || section.title || "Usage").slice(0, 120), points };
    }
    if (!rows.length && !chart) return [];
    return [{ title: typeof section.title === "string" ? section.title.slice(0, 120) : "Details", rows, chart }];
  });
}

/**
 * @param {object} entry One object from the CLI's top-level array.
 * @returns {object|null} Normalized provider, or null if unusable.
 */
function parseProvider(entry) {
  if (!entry || typeof entry !== "object" || !entry.provider) return null;

  const id = String(entry.provider);
  const base = {
    id,
    name: PROVIDER_NAMES[id] || id,
    source: entry.source || "",
    account: entry.account || entry.usage?.accountEmail || "",
  };

  if (entry.error) {
    return { ...base, kind: "error", error: entry.error.message || "Unknown error" };
  }

  const usage = entry.usage;
  if (!usage || typeof usage !== "object") {
    return { ...base, kind: "error", error: "No usage data" };
  }

  const rawLabels = entry.rateWindowLabels || usage.rateWindowLabels || {};
  const windows = [];

  for (const key of WINDOW_KEYS) {
    const win = usage[key];
    if (!win || typeof win !== "object") continue;

    const usedPercent = percent(win.usedPercent ?? win.used_percent);
    if (usedPercent === null) continue;

    const value = win.resetDescription || win.reset_description || "";
    const meter = isMeterWindow(win);
    const windowMinutes =
      win.windowMinutes ?? win.window_minutes ??
      (win.windowSeconds ? Math.round(win.windowSeconds / 60) : null);

    windows.push({
      key,
      rawLabel: rawLabels[key] || "",
      label: displayLabel(rawLabels[key]),
      usedPercent,
      meter,
      value: meter ? "" : value,
      resetsAt: meter ? win.resetsAt || win.resets_at || null : null,
      windowMinutes: meter ? windowMinutes ?? null : null,
      // The CLI sends a ready-made summary per window. Prefer it over
      // recomputing; fall back to null and let the caller decide.
      pace: entry.pace?.[key] || null,
    });
  }
  return {
    ...base,
    kind: windows.length === 0 ? "error" : windows.some((w) => w.meter) ? "windows" : "balance",
    windows,
    creditsRemaining: entry.credits?.remaining ?? null,
    resetCreditsAvailable: entry.resetCredits?.available ?? null,
    plan: usage.identity?.loginMethod || usage.loginMethod || null,
    details: parseDetails(usage.details),
    updatedAt: usage.updatedAt || null,
    error: windows.length === 0 ? "No usage windows reported" : null,
  };
}

/**
 * Parse the full CLI payload into providers ready to render.
 * Never throws: bad input yields fewer providers, not an exception.
 *
 * @param {unknown} payload Parsed JSON from `codexbar usage --format json`.
 * @returns {{providers: Array<object>}}
 */
export function parseUsagePayload(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const providers = [];
  for (const entry of list) {
    const parsed = parseProvider(entry);
    if (parsed) providers.push(parsed);
  }
  return { providers };
}
