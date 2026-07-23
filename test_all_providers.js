import {
  calculateUsagePace,
  formatResetDescription,
  UsageApiClient,
} from "./usageApi.js";

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

const testCases = [
  {
    name: "OpenRouter (User reported)",
    data: {
      loginMethod: "Balance: $35.05",
      openRouterUsage: {
        balance: 35.05187273999999,
        totalCredits: 160,
        totalUsage: 124.94812726,
        usedPercent: 78.0925795375,
      },
    },
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
