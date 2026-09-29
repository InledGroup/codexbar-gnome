import {
  calculateUsagePace,
  deriveCreditsPercent,
  formatResetDescription,
  normalizeDetailSections,
  UsageApiClient,
} from "./usageApi.js";
import {
  adoptCustomProviders,
  buildCliCommand,
  parseGeneratedCommand,
} from "./providerSources.js";

const client = new UsageApiClient();

// Es aquí donde debes añadir para testear
const codexSparkUsage = {
  accountEmail: "user@example.com",
  updatedAt: "2026-07-10T13:08:58Z",
  identity: { providerID: "codex" },
  primary: {
    usedPercent: 49,
    windowMinutes: 300,
    resetsAt: "2030-01-01T17:06:02Z",
  },
  secondary: {
    usedPercent: 24,
    windowMinutes: 10080,
    resetsAt: "2030-01-01T06:17:16Z",
  },
  tertiary: null,
  extraRateWindows: [
    {
      id: "codex-spark",
      title: "Codex Spark 5-hour",
      window: {
        usedPercent: 5,
        windowMinutes: 300,
        resetsAt: "2030-01-01T18:08:57Z",
      },
    },
    {
      id: "codex-spark-weekly",
      title: "Codex Spark Weekly",
      window: {
        usedPercent: 3,
        windowMinutes: 10080,
        resetsAt: "2030-01-01T13:08:57Z",
      },
    },
  ],
};

// OpenRouter CLI (v0.55.0): `codexbar --provider openrouter --source api --format json`.
// Hoisted to module scope so the testCases entry below and the top-level
// normalizeDetailSections assertions share the same fixture.
const openRouterDetailsPayload = {
  loginMethod: "Balance: $0.82",
  primary: { usedPercent: 0 },
  details: [
    {
      title: "Credits",
      rows: [
        { label: "Remaining", value: "$0.82" },
        { label: "Used", value: "$9.18" },
        { label: "Total added", value: "$10.00" },
      ],
    },
    {
      title: "API key",
      rows: [
        { label: "API key budget", value: "$5.00" },
        { label: "API key remaining", value: "$5.00" },
        { label: "API key used", value: "$0.94" },
        { label: "Reset window", value: "weekly" },
        { label: "Today", value: "$0.12" },
        { label: "This week", value: "$0.45" },
        { label: "This month", value: "$0.94" },
        { label: "Rate limit", value: "-1 requests / 10s" },
      ],
      chart: { kind: "bars", unit: "USD", points: [0.12, 0.45, 0.94] },
    },
    {
      title: "Spend history",
      rows: [
        {
          label: "Last 30 days",
          value: "Unavailable right now",
          secondaryValue: "Management API key not configured",
        },
      ],
    },
  ],
};

const testCases = [
  {
    name: "OpenRouter (User reported)",
    data: openRouterDetailsPayload,
    expectedUsedPercent: 0,
  },
  {
    name: "OpenAI / Codex (Standard)",
    data: {
      email: "user@example.com",
      usage: [
        {
          used: 10,
          limit: 50,
          window_seconds: 10800,
          reset_after_seconds: 3600,
        },
      ],
    },
  },
  {
    name: "OpenAI Free (used_percent)",
    data: {
      used_percent: 45.5,
      limit_window_seconds: 3600,
    },
    expectedUsedPercent: 45.5,
  },
  {
    name: "Codex rate_limit windows (1% used)",
    data: {
      rate_limit: {
        primary_window: {
          used_percent: 1,
          limit_window_seconds: 18000,
          reset_after_seconds: 7200,
        },
        secondary_window: {
          used_percent: 12,
          limit_window_seconds: 604800,
          reset_after_seconds: 432000,
        },
      },
    },
    expectedUsedPercent: 1,
  },
  {
    name: "Codex remaining_percent",
    data: {
      primary: {
        remaining_percent: 99,
        limit_window_seconds: 18000,
      },
    },
    expectedUsedPercent: 1,
  },
  {
    name: "Generic CLI (remaining/total)",
    data: {
      remaining: 5,
      total: 20,
    },
    expectedUsedPercent: 75,
  },
  {
    name: "Codex with Spark extra rate windows",
    data: { provider: "codex", usage: codexSparkUsage },
    expectedUsedPercent: 49,
  },
  {
    name: "Antigravity (User reported)",
    data: {
      provider: "antigravity",
      source: "cli",
      usage: {
        primary: {
          usedPercent: 0.42785999999999547,
          windowMinutes: 300,
          resetsAt: "2026-06-19T12:39:05Z",
          resetDescription:
            "You have used some of your 5-hour limit, it will fully refresh in 4 hours, 59 minutes.",
        },
        identity: {
          accountEmail: "user@example.com",
          loginMethod: "Google AI Pro",
          providerID: "antigravity",
        },
        extraRateWindows: [
          {
            title: "Gemini Session",
            id: "antigravity-quota-summary-gemini-5h",
            window: {
              resetsAt: "2026-06-19T12:39:05Z",
              windowMinutes: 300,
              usedPercent: 0.42785999999999547,
              resetDescription:
                "You have used some of your 5-hour limit, it will fully refresh in 4 hours, 59 minutes.",
            },
          },
          {
            title: "Gemini Weekly",
            id: "antigravity-quota-summary-gemini-weekly",
            window: {
              resetsAt: "2026-06-26T07:39:05Z",
              windowMinutes: 10080,
              usedPercent: 0.07130499999999529,
              resetDescription:
                "You have used some of your weekly limit, it will fully refresh in 6 days, 23 hours.",
            },
          },
          {
            title: "Claude + GPT Session",
            id: "antigravity-quota-summary-3p-5h",
            window: {
              usedPercent: 0,
              resetsAt: "2026-06-19T12:39:33Z",
              windowMinutes: 300,
            },
          },
          {
            title: "Claude + GPT Weekly",
            id: "antigravity-quota-summary-3p-weekly",
            window: {
              resetsAt: "2026-06-26T07:39:33Z",
              windowMinutes: 10080,
              usedPercent: 0,
            },
          },
        ],
        accountEmail: "user@example.com",
        updatedAt: "2026-06-19T07:39:33Z",
        tertiary: null,
        secondary: {
          usedPercent: 0,
          windowMinutes: 300,
          resetsAt: "2026-06-19T12:39:33Z",
        },
        loginMethod: "Google AI Pro",
      },
    },
    expectedUsedPercent: 0.42786,
  },
];

console.log("--- Testing normalizeSummary for multiple formats ---\n");

testCases.forEach((test) => {
  console.log(`Testing: ${test.name}`);
  try {
    const payload = test.data.usage || test.data;
    const isAntigravity =
      test.name.includes("Antigravity") || test.data.provider === "antigravity";
    const normalized = client.normalizeSummary(payload, isAntigravity);
    const primary = normalized.usage.primary;

    if (primary) {
      console.log(`  ✓ Success: ${primary.usedPercent.toFixed(2)}% used`);
      if (primary.resetDescription)
        console.log(`  └─ Reset: ${primary.resetDescription}`);

      if (
        test.expectedUsedPercent !== undefined &&
        Math.abs(primary.usedPercent - test.expectedUsedPercent) > 0.0001
      ) {
        throw new Error(
          `Expected ${test.expectedUsedPercent}% used, got ${primary.usedPercent}%`,
        );
      }
    } else {
      console.log("  ✗ Failed: No primary window found");
    }
  } catch (e) {
    console.log(`  ✗ Error: ${e.message}`);
  }
  console.log("");
});

const now = new Date(2026, 5, 14, 10, 0);
const sameDayWeeklyReset = formatResetDescription(2 * 3600, 7 * 24 * 3600, now);
const laterWeeklyReset = formatResetDescription(
  2 * 24 * 3600,
  7 * 24 * 3600,
  now,
);
const sameDayTime = new Date(2026, 5, 14, 12, 0).toLocaleTimeString([], {
  hour: "2-digit",
  minute: "2-digit",
});
const laterDateTime = new Date(2026, 5, 16, 10, 0).toLocaleString([], {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

if (sameDayWeeklyReset !== `Resets at ${sameDayTime} (in 2h)`) {
  throw new Error(
    `Same-day weekly reset should omit the date: ${sameDayWeeklyReset}`,
  );
}
if (laterWeeklyReset !== `Resets at ${laterDateTime} (in 48h)`) {
  throw new Error(
    `Later weekly reset should include the date: ${laterWeeklyReset}`,
  );
}

console.log(
  "✓ Weekly reset dates are shown only when the reset is on another day",
);

const screenshotPace = calculateUsagePace({
  usedPercent: 2,
  windowSeconds: 7 * 24 * 3600,
  resetAfterSeconds: (6 * 24 + 14) * 3600,
});
if (!screenshotPace || Math.round(screenshotPace.reservePercent) !== 4) {
  throw new Error(
    `Expected the screenshot's weekly window to have 4% in reserve, got ${screenshotPace?.reservePercent}`,
  );
}
console.log("✓ Weekly usage pace calculates reserve from the reset window");

// Codex + Spark: canonical windows stay in primary/secondary, Spark windows
// fill tertiary/quaternary, and labels cover all four tiers in order.
const codexSpark = client.normalizeSummary(codexSparkUsage, false);
const sparkExpectations = [
  ["primary", 49],
  ["secondary", 24],
  ["tertiary", 5],
  ["quaternary", 3],
];
sparkExpectations.forEach(([tier, expected]) => {
  const win = codexSpark.usage[tier];
  if (!win || Math.abs(win.usedPercent - expected) > 0.0001) {
    throw new Error(
      `Codex Spark: expected ${tier} at ${expected}% used, got ${win ? win.usedPercent : "null"}`,
    );
  }
});
const expectedSparkLabels = [
  "5-Hour Window",
  "Weekly Window",
  "Codex Spark 5-hour",
  "Codex Spark Weekly",
];
if (JSON.stringify(codexSpark.labels) !== JSON.stringify(expectedSparkLabels)) {
  throw new Error(
    `Codex Spark: expected labels ${JSON.stringify(expectedSparkLabels)}, got ${JSON.stringify(codexSpark.labels)}`,
  );
}

console.log(
  "✓ Codex extraRateWindows are appended after canonical windows with labels",
);

// The direct ChatGPT endpoint exposes Spark as additional_rate_limits rather
// than the CLI's normalized extraRateWindows shape.
const directCodexSpark = client.normalizeSummary({
  email: "spark@example.com",
  plan_type: "prolite",
  rate_limit: {
    primary_window: {
      used_percent: 2,
      limit_window_seconds: 18000,
      reset_after_seconds: 14400,
    },
    secondary_window: {
      used_percent: 4,
      limit_window_seconds: 604800,
      reset_after_seconds: 518400,
    },
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_after_seconds: 17640,
        },
        secondary_window: {
          used_percent: 0,
          limit_window_seconds: 604800,
          reset_after_seconds: 572400,
        },
      },
    },
  ],
});

const directSparkExpectations = [
  ["primary", 2],
  ["secondary", 4],
  ["tertiary", 0],
  ["quaternary", 0],
];
directSparkExpectations.forEach(([tier, expected]) => {
  const actual = directCodexSpark.usage[tier]?.usedPercent;
  if (actual !== expected) {
    throw new Error(
      `Direct Codex Spark: expected ${tier} at ${expected}% used, got ${actual}`,
    );
  }
});
const expectedDirectSparkLabels = [
  "5-Hour Window",
  "Weekly Window",
  "Codex Spark 5-hour",
  "Codex Spark Weekly",
];
if (
  JSON.stringify(directCodexSpark.labels) !==
  JSON.stringify(expectedDirectSparkLabels)
) {
  throw new Error(
    `Direct Codex Spark: expected labels ${JSON.stringify(expectedDirectSparkLabels)}, got ${JSON.stringify(directCodexSpark.labels)}`,
  );
}
console.log("✓ Direct Codex additional_rate_limits render as Spark tiers");

// Codex dashboard metadata that is available from the Linux usage endpoint.
const codexDashboardPayload = {
  email: "user@example.com",
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 10,
      limit_window_seconds: 604800,
      reset_after_seconds: 566279,
    },
  },
  code_review_rate_limit: {
    primary_window: {
      used_percent: 2,
      limit_window_seconds: 604800,
      reset_after_seconds: 400000,
    },
  },
  rate_limit_reset_credits: {
    available_count: 2,
  },
};
const normalizedDashboard = client.normalizeSummary(codexDashboardPayload);
if (normalizedDashboard.usage.planType !== "plus") {
  throw new Error("Expected Codex plan type to be preserved");
}
if (normalizedDashboard.usage.codeReview?.usedPercent !== 2) {
  throw new Error("Expected Codex code review limit to be normalized");
}
if (normalizedDashboard.usage.rateLimitResetCredits?.availableCount !== 2) {
  throw new Error("Expected Codex reset-credit count to be normalized");
}
console.log("\u2713 Codex plan, code review, and reset credits normalize correctly");

// Test OpenCode Go Zen providerCost normalization
const zenPayload = {
  updatedAt: "2026-07-15T10:00:00Z",
  primary: null,
  secondary: null,
  tertiary: null,
  providerCost: {
    used: 73.63,
    limit: 0,
    currencyCode: "USD",
    period: "Zen balance"
  }
};
const normalizedZen = client.normalizeSummary(zenPayload, false);
if (!normalizedZen.usage.providerCost) {
  throw new Error("Expected providerCost to be present in normalized output");
}
if (normalizedZen.usage.providerCost.used !== 73.63) {
  throw new Error(`Expected providerCost.used to be 73.63, got ${normalizedZen.usage.providerCost.used}`);
}
if (normalizedZen.usage.providerCost.limit !== 0) {
  throw new Error(`Expected providerCost.limit to be 0, got ${normalizedZen.usage.providerCost.limit}`);
}
if (normalizedZen.usage.providerCost.currencyCode !== "USD") {
  throw new Error(`Expected providerCost.currencyCode to be 'USD', got '${normalizedZen.usage.providerCost.currencyCode}'`);
}
if (normalizedZen.usage.providerCost.period !== "Zen balance") {
  throw new Error(`Expected providerCost.period to be 'Zen balance', got '${normalizedZen.usage.providerCost.period}'`);
}
console.log("✓ OpenCode Go Zen providerCost normalizes correctly");

// Ollama Cloud HTML parser test
const { OllamaSettingsFetcher } = await import("./adapters/OllamaSettingsFetcher.js");
const ollamaFetcher = new OllamaSettingsFetcher();
const ollamaHtml = `
  <main>
    <h2>Cloud Usage</h2>
    <div>Plan: Pro</div>
    <section>
      <h3>Session usage</h3>
      <span>12.5%</span>
      <span>resets in 2 hours</span>
    </section>
    <section>
      <h3>Weekly usage</h3>
      <span>54.2%</span>
      <span>resets in 6 days, 3 hours</span>
    </section>
  </main>`;
const ollamaSummary = ollamaFetcher._parseSettingsHtml(ollamaHtml);
if (ollamaSummary.labels[0] !== "Session" || ollamaSummary.labels[1] !== "Weekly") {
  throw new Error("Ollama labels should be Session and Weekly");
}
if (ollamaSummary.usage.primary.usedPercent !== 12.5) {
  throw new Error(`Expected Ollama session usage 12.5%, got ${ollamaSummary.usage.primary.usedPercent}%`);
}
if (ollamaSummary.usage.secondary.usedPercent !== 54.2) {
  throw new Error(`Expected Ollama weekly usage 54.2%, got ${ollamaSummary.usage.secondary.usedPercent}%`);
}
if (ollamaSummary.usage.loginMethod !== "Ollama Cloud Pro") {
  throw new Error(`Expected Ollama Cloud Pro login method, got ${ollamaSummary.usage.loginMethod}`);
}
console.log("✓ Ollama Cloud HTML parser extracts Session and Weekly usage");

// OpenRouter details: normalizeSummary must pass usage.details through untouched,
// and normalizeDetailSections must sanitize it into a flat, render-safe shape.
const normalizedOpenRouter = client.normalizeSummary(openRouterDetailsPayload, false);
if (
  !Array.isArray(normalizedOpenRouter.usage.details) ||
  normalizedOpenRouter.usage.details.length !== 3
) {
  throw new Error(
    `Expected normalizeSummary to pass through 3 detail sections, got ${JSON.stringify(normalizedOpenRouter.usage.details)}`,
  );
}
console.log("✓ usage.details survives normalizeSummary untouched");

const openRouterSections = normalizeDetailSections(normalizedOpenRouter.usage.details);
if (openRouterSections.length !== 3) {
  throw new Error(`Expected 3 sanitized detail sections, got ${openRouterSections.length}`);
}
const rowCounts = openRouterSections.map((s) => s.rows.length).join(",");
if (rowCounts !== "3,8,1") {
  throw new Error(`Expected section row counts "3,8,1", got "${rowCounts}"`);
}
if (
  openRouterSections[0].rows[0].label !== "Remaining" ||
  openRouterSections[0].rows[0].value !== "$0.82"
) {
  throw new Error(
    `Expected first Credits row to be Remaining/$0.82, got ${JSON.stringify(openRouterSections[0].rows[0])}`,
  );
}
console.log("✓ normalizeDetailSections produces the correct sections and rows");

if (!openRouterSections[1].hasChart || "chart" in openRouterSections[1]) {
  throw new Error(
    "Expected the API key section to record hasChart:true without leaking the raw chart",
  );
}
console.log("✓ chart is detected via hasChart but not leaked into the sanitized shape");

if (
  openRouterSections[2].rows[0].secondaryValue !==
  "Management API key not configured"
) {
  throw new Error(
    `Expected Spend history secondaryValue to be preserved, got "${openRouterSections[2].rows[0].secondaryValue}"`,
  );
}
console.log("✓ secondaryValue is preserved on sanitized rows");

// Defensive shapes: anything that isn't a usable details array normalizes to [].
[undefined, null, "nope", 42, {}, { rows: [] }].forEach((input) => {
  const result = normalizeDetailSections(input);
  if (result.length !== 0) {
    throw new Error(
      `Expected normalizeDetailSections(${JSON.stringify(input)}) to be [], got ${JSON.stringify(result)}`,
    );
  }
});
console.log("✓ normalizeDetailSections defends against non-array and malformed inputs");

// A section with only a chart (no rows) is dropped, not rendered as a bare title.
if (normalizeDetailSections([{ title: "Chart only", chart: { kind: "bars" } }]).length !== 0) {
  throw new Error("Expected a chart-only section with no rows to be dropped");
}
console.log("✓ chart-only sections with no rows are dropped");

// Value coercion: 0 must render as "0" (not "" via a naive `row.value || ""` guard),
// NaN/objects must coerce to "", and rows need at least a label or a value to survive.
const coercionRows = normalizeDetailSections([
  {
    title: "Coercion",
    rows: [
      { label: "num", value: 0 },
      { label: "nan", value: NaN },
      { label: "obj", value: {} },
      { label: "", value: "" },
      { label: "b", value: true },
    ],
  },
])[0].rows;
if (coercionRows.length !== 4) {
  throw new Error(`Expected 4 surviving rows after coercion, got ${coercionRows.length}`);
}
if (coercionRows[0].value !== "0") {
  throw new Error(`Expected numeric 0 to coerce to "0", got "${coercionRows[0].value}"`);
}
if (coercionRows[1].value !== "") {
  throw new Error(`Expected NaN to coerce to "", got "${coercionRows[1].value}"`);
}
if (coercionRows[2].value !== "") {
  throw new Error(`Expected an object value to coerce to "", got "${coercionRows[2].value}"`);
}
console.log("✓ row value coercion handles 0, NaN, objects, and empty rows correctly");

// Claude regression guard: providers with no `details` key must be unaffected.
if (normalizeDetailSections(normalizedDashboard.usage.details).length !== 0) {
  throw new Error("Expected a provider with no details key to produce zero sections");
}
console.log("✓ providers without usage.details are unaffected (Claude/Codex regression guard)");

// deriveCreditsPercent: OpenRouter's degenerate {usedPercent:0, windowSeconds:0}
// "Usage Window" tier is meaningless; derive a real percent from the API key
// section's budget and remaining/used if present, or fall back to Credits section.
const apiKeyCreditsPercent = deriveCreditsPercent(openRouterSections);
if (apiKeyCreditsPercent === null || Math.abs(apiKeyCreditsPercent - 0) > 0.0001) {
  throw new Error(`Expected API key budget-derived percent of 0, got ${apiKeyCreditsPercent}`);
}
console.log("✓ deriveCreditsPercent computes used% from API key budget and remaining");

const customApiKeySection = [
  {
    title: "API key",
    rows: [
      { label: "API key budget", value: "$5.00" },
      { label: "API key remaining", value: "$1.00" },
    ],
  },
];
const customApiKeyPercent = deriveCreditsPercent(customApiKeySection);
if (customApiKeyPercent === null || Math.abs(customApiKeyPercent - 80) > 0.0001) {
  throw new Error(`Expected custom API key budget percent of 80, got ${customApiKeyPercent}`);
}
console.log("✓ deriveCreditsPercent computes 80% used when $1.00 remains of $5.00 API key budget");

const creditsOnlySections = openRouterSections.filter((s) => s.title !== "API key");
const creditsFallbackPercent = deriveCreditsPercent(creditsOnlySections);
if (creditsFallbackPercent === null || Math.abs(creditsFallbackPercent - 91.8) > 0.0001) {
  throw new Error(`Expected Credits section fallback percent of 91.8, got ${creditsFallbackPercent}`);
}
console.log("✓ deriveCreditsPercent falls back to Credits section's Used/Total added when no API key budget");

if (deriveCreditsPercent([]) !== null) {
  throw new Error("Expected deriveCreditsPercent([]) to be null (no sections)");
}
if (deriveCreditsPercent(normalizeDetailSections(normalizedDashboard.usage.details)) !== null) {
  throw new Error("Expected deriveCreditsPercent to be null for a provider with no details");
}
console.log("✓ deriveCreditsPercent is null when there's no parseable API key budget or Credits section");

// --- Provider connection sources -------------------------------------------

const KNOWN_PROVIDERS = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];

if (buildCliCommand("claude", "oauth") !==
    "codexbar --provider claude --source oauth --format json") {
  throw new Error(`Unexpected generated command: ${buildCliCommand("claude", "oauth")}`);
}
for (const source of ["auto", "web", "cli", "oauth", "api"]) {
  const parsed = parseGeneratedCommand(buildCliCommand("claude", source));
  if (!parsed || parsed.cliId !== "claude" || parsed.source !== source) {
    throw new Error(`buildCliCommand/parseGeneratedCommand failed to round-trip ${source}`);
  }
}
console.log("✓ buildCliCommand round-trips through parseGeneratedCommand for every source");

// The form users actually have saved: absolute path plus the `usage` subcommand.
const absolute = parseGeneratedCommand(
  "/usr/local/bin/codexbar usage --provider claude --source oauth --format json",
);
if (!absolute || absolute.cliId !== "claude" || absolute.source !== "oauth") {
  throw new Error("Expected an absolute path with `usage` to parse");
}
console.log("✓ parseGeneratedCommand accepts an absolute binary path and the usage subcommand");

if (parseGeneratedCommand("codexbar --provider claude --source oauth --format json --account work")) {
  throw new Error("Expected a command with extra flags to be rejected");
}
if (parseGeneratedCommand("codexbar --provider claude --source nonsense --format json")) {
  throw new Error("Expected an unknown source to be rejected");
}
if (parseGeneratedCommand("") || parseGeneratedCommand(undefined)) {
  throw new Error("Expected empty/undefined commands to be rejected");
}
console.log("✓ parseGeneratedCommand rejects extra flags, unknown sources, and empty input");

const handRolled = [
  {
    id: "custom-1788415760189",
    name: "Codex OAuth",
    command: "/usr/local/bin/codexbar usage --provider codex --source oauth --format json",
    useApi: false,
  },
  {
    id: "custom-1788415778976",
    name: "Claude OAuth",
    command: "/usr/local/bin/codexbar usage --provider claude --source oauth --format json",
    useApi: false,
  },
];
const adopted = adoptCustomProviders(handRolled, KNOWN_PROVIDERS);
if (adopted.map((p) => p.id).join(",") !== "codex,claude") {
  throw new Error(`Expected custom rows to be adopted as codex,claude - got ${adopted.map((p) => p.id).join(",")}`);
}
if (adopted.some((p) => p.source !== "oauth" || p.useApi !== false)) {
  throw new Error("Expected adopted rows to keep source=oauth and useApi=false");
}
if (handRolled[0].id !== "custom-1788415760189") {
  throw new Error("adoptCustomProviders must not mutate its input");
}
console.log("✓ adoptCustomProviders folds hand-rolled OAuth rows onto their predefined ids");

const withExtraFlags = adoptCustomProviders(
  [{ id: "custom-1", name: "Claude work", command: "codexbar --provider claude --source oauth --format json --account work" }],
  KNOWN_PROVIDERS,
);
if (withExtraFlags[0].id !== "custom-1") {
  throw new Error("Expected a command with --account to be left as a custom provider");
}
console.log("✓ adoptCustomProviders leaves deliberately custom commands alone");

const alreadyConfigured = adoptCustomProviders(
  [
    { id: "claude", name: "Claude", command: buildCliCommand("claude", "cli"), useApi: false },
    { id: "custom-2", name: "Claude OAuth", command: buildCliCommand("claude", "oauth"), useApi: false },
  ],
  KNOWN_PROVIDERS,
);
if (alreadyConfigured[1].id !== "custom-2") {
  throw new Error("Expected no adoption when the predefined provider is already configured");
}
console.log("✓ adoptCustomProviders won't collide with an already-configured predefined provider");

if (adoptCustomProviders(null, KNOWN_PROVIDERS).length !== 0) {
  throw new Error("Expected adoptCustomProviders(null) to return an empty list");
}
console.log("✓ adoptCustomProviders defends against a malformed provider list");

// Ollama Cloud monthly credit-pool parser test (transparent per-token pricing)
const ollamaCreditHtml = `
  <main>
    <h2>Usage</h2>
    <div>Plan: Pro</div>
    <section>
      <h3>Monthly usage $12.34 of $60 used</h3>
      <span>Resets in 3 weeks.</span>
    </section>
    <section>
      <h3>Usage credits</h3>
      <span>$5 Current balance</span>
    </section>
  </main>`;
const ollamaCredit = ollamaFetcher._parseSettingsHtml(ollamaCreditHtml);
const creditWin = ollamaCredit.usage.primary;
if (!creditWin || ollamaCredit.usage.secondary !== null) {
  throw new Error("Ollama credit mode should set only the primary tier");
}
if (Math.abs(creditWin.usedPercent - (12.34 / 60) * 100) > 0.0001) {
  throw new Error(`Expected Ollama monthly usage ${((12.34 / 60) * 100).toFixed(2)}%, got ${creditWin.usedPercent}%`);
}
if (!creditWin.resetDescription.includes("$12.34 / $60.00")) {
  throw new Error(`Expected dollar amounts in reset description, got "${creditWin.resetDescription}"`);
}
if (!creditWin.resetDescription.includes("Resets in 3 weeks")) {
  throw new Error(`Expected relative reset text in reset description, got "${creditWin.resetDescription}"`);
}
if (ollamaCredit.labels[0] !== "Monthly usage (+$5.00 credits)") {
  throw new Error(`Expected balance label, got "${ollamaCredit.labels[0]}"`);
}
if (ollamaCredit.usage.loginMethod !== "Ollama Cloud Pro") {
  throw new Error(`Expected Ollama Cloud Pro login method, got ${ollamaCredit.usage.loginMethod}`);
}
console.log("✓ Ollama Cloud HTML parser extracts monthly credit pool as tier");

// Ollama Cloud billing-page reset date test (date generated ~20 days out)
const billingReset = new Date(Date.now() + 20 * 24 * 3600 * 1000);
const billingDateStr = billingReset.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const billingShort = billingReset.toLocaleDateString([], { month: "short", day: "numeric" });
const ollamaBillingHtml = `
  <main>
    <h2>Plan & Billing</h2>
    <div>Pro Your subscription renews on ${billingDateStr}.</div>
  </main>`;
const ollamaCreditBilled = ollamaFetcher._parseSettingsHtml(ollamaCreditHtml, ollamaBillingHtml);
const billedWin = ollamaCreditBilled.usage.primary;
if (!billedWin || billedWin.resetAfterSeconds <= 0) {
  throw new Error("Ollama billing reset date should yield positive resetAfterSeconds");
}
if (!billedWin.resetDescription.includes(`Resets ${billingShort}`)) {
  throw new Error(`Expected exact reset date in reset description, got "${billedWin.resetDescription}"`);
}
if (ollamaCreditBilled.usage.loginMethod !== "Ollama Cloud Pro") {
  throw new Error(`Expected Ollama Cloud Pro from billing plan, got ${ollamaCreditBilled.usage.loginMethod}`);
}
const billedPace = calculateUsagePace({
  usedPercent: billedWin.usedPercent,
  windowSeconds: billedWin.windowSeconds,
  resetAfterSeconds: billedWin.resetAfterSeconds,
});
if (!billedPace) {
  throw new Error("Expected pace calculation for the monthly window");
}
console.log("✓ Ollama Cloud billing page yields exact reset date and pace");
