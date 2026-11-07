// Headless parsing tests. Run: gjs -m test/test-parse.js
// Reads fixtures captured from the real CLI and asserts the normalized shape
// the UI depends on. No GNOME imports beyond GLib, so this runs anywhere gjs does.

import GLib from "gi://GLib";

// Run from the repo root: gjs -m test/test-parse.js
const ROOT = GLib.get_current_dir();
const FIXTURES = GLib.build_filenamev([ROOT, "fixtures"]);
const { parseUsagePayload, PROVIDER_NAMES } = await import(
  GLib.filename_to_uri(GLib.build_filenamev([ROOT, "parse.js"]), null)
);

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n         got:      ${a}\n         expected: ${e}`);
  }
}

function loadFixture(name) {
  const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([FIXTURES, name]));
  if (!ok) throw new Error(`missing fixture ${name}`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

console.log("usage-all.json: two providers, window and balance shapes");
const all = parseUsagePayload(loadFixture("usage-all.json"));

check("provider count", all.providers.length, 2);
check(
  "provider ids",
  all.providers.map((p) => p.id),
  ["opencodego", "deepseek"],
);
check(
  "display names",
  all.providers.map((p) => p.name),
  ["OpenCode Go", "DeepSeek"],
);
check("opencodego kind", all.providers[0].kind, "windows");
check("deepseek kind", all.providers[1].kind, "balance");

console.log("opencodego: labels come from rateWindowLabels, not window length");
const ocg = all.providers[0];
check("window count", ocg.windows.length, 3);
check("raw labels", ocg.windows.map((w) => w.rawLabel), ["5-hour", "Weekly", "Monthly"]);
check("display labels", ocg.windows.map((w) => w.label), ["Session", "Weekly", "Monthly"]);
check("percentages", ocg.windows.map((w) => w.usedPercent), [74, 44, 57]);
check(
  "resetsAt parsed",
  ocg.windows.map((w) => w.resetsAt),
  [
    "2026-10-08T00:16:07Z",
    "2026-10-11T23:59:59Z",
    "2026-10-18T12:48:53Z",
  ],
);

console.log("opencodego: pace summaries come from the CLI");
check(
  "pace summaries",
  ocg.windows.map((w) => w.pace?.summary),
  [
    "20% in deficit | Expected 54% used | Projected empty in 57m",
    "2% in deficit | Expected 42% used | Runs out in 3d 17h",
    "8% in reserve | Expected 65% used | Lasts until reset",
  ],
);
check(
  "pace stages",
  ocg.windows.map((w) => w.pace?.stage),
  ["farAhead", "slightlyAhead", "behind"],
);
check(
  "willLastToReset",
  ocg.windows.map((w) => w.pace?.willLastToReset),
  [false, false, true],
);

console.log("opencodego: percentages are rounded, not 56.99999999999999");
check("no float noise", ocg.windows.every((w) => Number.isInteger(w.usedPercent)), true);

console.log("deepseek: balance window renders a value, not a 0% bar");
const ds = all.providers[1];
check("balance windows", ds.windows.length, 1);
check("balance label", ds.windows[0].label, "Balance");
check("balance has no resetsAt", ds.windows[0].resetsAt, null);
check("balance has no pace", ds.windows[0].pace, null);
check(
  "balance value",
  ds.windows[0].value,
  "$10.26 (Paid: $10.26 / Granted: $0.00)",
);
check("account", ds.account, "personal");

console.log("codex: parse credits, plan, and pace summary");
const codex = parseUsagePayload(loadFixture("usage-codex.json")).providers[0];
check("codex kind", codex.kind, "windows");
check("codex credits remaining", codex.creditsRemaining, 0);
check("codex reset credits available", codex.resetCreditsAvailable, 0);
check("codex plan", codex.plan, "plus");
check("codex pace summary", codex.windows[0].pace.summary,
  "On pace | Expected 5% used | Runs out in 6d 14h");

console.log("z.ai quota details, plan, and model-usage charts are retained");
const zai = parseUsagePayload([{
  provider: "zai",
  rateWindowLabels: { primary: "5-hour", secondary: "Weekly" },
  usage: {
    identity: { loginMethod: "lite" },
    primary: { usedPercent: 0, windowMinutes: 300, resetDescription: "5-hour" },
    secondary: { usedPercent: 100, windowMinutes: 10080, resetDescription: "1 week window" },
    details: [
      { title: "Quota details", rows: [
        { label: "Credit quota", value: "100% used", secondaryValue: "10000 limit · 0 remaining" },
        { label: "Quota rate", value: "Off-peak", secondaryValue: "peak in 1d 6h" },
      ] },
      { title: "Hourly tokens", rows: [{ label: "GLM-5.3-Flash", value: "9.73M" }],
        chart: { kind: "bars", title: "Hourly tokens", unit: "tokens", points: [
          { label: "2026-11-07 00:00", value: 6582896 },
        ] } },
    ],
  },
}]).providers[0];
check("z.ai quota windows", zai.windows.map((w) => [w.label, w.usedPercent]), [["Session", 0], ["Weekly", 100]]);
check("z.ai plan", zai.plan, "lite");
check("z.ai quota detail row", zai.details[0].rows[0], {
  label: "Credit quota", value: "100% used", secondaryValue: "10000 limit · 0 remaining",
});
check("z.ai chart points", zai.details[1].chart.points, [{ label: "2026-11-07 00:00", value: 6582896 }]);

console.log("errors surface as a tab, not a crash");
const withError = parseUsagePayload([
  { provider: "opencodego", source: "local+api", usage: loadFixture("usage-opencodego.json")[0].usage },
  { provider: "deepseek", source: "api", error: { message: "Missing DeepSeek API key.", kind: "provider", code: 1 } },
]);
check("error provider kept", withError.providers.length, 2);
check("error kind", withError.providers[1].kind, "error");
check("error message", withError.providers[1].error, "Missing DeepSeek API key.");

console.log("empty and malformed payloads do not throw");
check("empty array", parseUsagePayload([]).providers, []);
check("null", parseUsagePayload(null).providers, []);
check("not an array", parseUsagePayload({ provider: "x" }).providers, []);
check("garbage json handled", parseUsagePayload([{ provider: "x", usage: 5 }]).providers.length, 1);

console.log("unknown provider ids still get a name");
check(
  "fallback name",
  parseUsagePayload([{ provider: "brandnew", usage: { primary: { usedPercent: 5, windowMinutes: 300 } } }])
    .providers[0].name,
  "brandnew",
);
check("known names have no spaces", Object.values(PROVIDER_NAMES).every((n) => n === n.trim()), true);

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  // Non-zero exit so CI catches it.
  imports.system.exit(1);
}
