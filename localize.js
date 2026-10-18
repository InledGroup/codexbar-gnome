// Locale-aware formatting for text the extension doesn't author itself:
// labels and detail rows that arrive from codexbar-cli in English, reset
// countdowns and the panel text. Kept free of gi:// imports so it can be
// unit tested; callers pass the gettext function as `tr`.

// UI language. The catalog is loaded from the extension's own locale/ folder
// (GNU .mo) so the language is an explicit user choice (the `language`
// setting) and never depends on the locale of the shell process.
const SUPPORTED_LANGUAGES = ["en", "es", "pt_BR"];
let _catalog = new Map();
let _language = "en";

/** Parse a GNU .mo blob (either endianness) into a msgid -> msgstr Map. */
export const parseMo = (data) => {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = view.getUint32(0, true);
  const little = magic === 0x950412de;
  if (!little && magic !== 0xde120495) return new Map();
  const count = view.getUint32(8, little);
  const originalsOffset = view.getUint32(12, little);
  const translationsOffset = view.getUint32(16, little);
  const decoder = new TextDecoder();
  const catalog = new Map();
  for (let i = 0; i < count; i++) {
    const origLength = view.getUint32(originalsOffset + i * 8, little);
    const origPosition = view.getUint32(originalsOffset + i * 8 + 4, little);
    const transLength = view.getUint32(translationsOffset + i * 8, little);
    const transPosition = view.getUint32(translationsOffset + i * 8 + 4, little);
    if (!origLength) continue; // header entry (metadata)
    const msgid = decoder.decode(u8.subarray(origPosition, origPosition + origLength));
    const msgstr = decoder.decode(u8.subarray(transPosition, transPosition + transLength));
    if (msgstr) catalog.set(msgid, msgstr);
  }
  return catalog;
};

/** Install the catalog for `lang`; `en` (or no catalog) keeps the msgids. */
export const setCatalog = (lang, catalog) => {
  _language = SUPPORTED_LANGUAGES.includes(lang) ? lang : "en";
  _catalog = _language === "en" || !catalog ? new Map() : catalog;
};

/** Load `lang` via `readFile(lang)` -> Uint8Array|null. English needs no file. */
export const applyLanguage = (lang, readFile) => {
  if (lang !== "en" && SUPPORTED_LANGUAGES.includes(lang) && readFile) {
    try {
      const bytes = readFile(lang);
      const catalog = bytes ? parseMo(bytes) : null;
      if (catalog && catalog.size > 0) {
        setCatalog(lang, catalog);
        return;
      }
    } catch (e) {
      // unreadable catalog -> full English fallback below
    }
  }
  setCatalog("en", null);
};

export const currentLanguage = () => _language;

/** Translation lookup; unknown strings fall back to the English msgid. */
export const tr = (s) => _catalog.get(s) ?? s;

/** BCP-47 tag for Intl; tied to the chosen language, not the process locale. */
const uiLocale = () => (_language === "en" ? "en" : _language.replace("_", "-"));

// Marks strings for xgettext that only exist at runtime (codexbar-cli output).
const N_ = (s) => s;
export const CLI_STRINGS = [
  N_("Cloud credits"),
  N_("Session"),
  N_("Weekly"),
  N_("Monthly"),
];

const fill = (template, ...values) => {
  let i = 0;
  return template.replace(/%[sd]/g, () => String(values[i++]));
};

/** 7 -> "7", 6.54 -> "6.5" ("6,5" in es/pt_BR). */
export const formatPercent = (value) =>
  Number(value || 0).toLocaleString(uiLocale(), { maximumFractionDigits: 1 });

/** Compact duration: "45min", "3h 9min", "5d 1h". */
export const formatDuration = (seconds) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const m = minutes % 60;
    return m ? `${hours}h ${m}min` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days}d`;
};

/**
 * "Resets at 23:09 (in 3h 9min)" or "Resets 21/10 at 20:59 (in 5d 1h)".
 * Computed at render time so the countdown doesn't go stale between refreshes.
 */
export const formatReset = (resetAfterSeconds, elapsedSeconds, tr, now = new Date()) => {
  const seconds = (resetAfterSeconds || 0) - (elapsedSeconds || 0);
  if (!(seconds > 0)) return "";
  const resetDate = new Date(now.getTime() + seconds * 1000);
  const time = resetDate.toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" });
  if (resetDate.toDateString() === now.toDateString())
    return fill(tr("Resets at %s (in %s)"), time, formatDuration(seconds));
  const day = resetDate.toLocaleDateString(uiLocale(), { day: "2-digit", month: "2-digit" });
  return fill(tr("Resets %s at %s (in %s)"), day, time, formatDuration(seconds));
};

/** Window labels, built by the extension or sent by the CLI ("Gemini 5-hour"). */
export const localizeLabel = (label, tr) => {
  if (!label) return label;
  const direct = tr(label);
  if (direct !== label) return direct;
  let m;
  if ((m = /^(\d+)-Hour Window$/i.exec(label))) return fill(tr("%d-Hour Window"), m[1]);
  if ((m = /^(\d+)-Day Window$/i.exec(label))) return fill(tr("%d-Day Window"), m[1]);
  // CLI-provided names ("Gemini 5-hour") are only rewritten when the
  // language actually has a translation; English keeps the CLI's wording.
  const translated = (template) => {
    const t = tr(template);
    return t !== template ? t : null;
  };
  let t;
  if ((m = /^(.+?) (\d+)-hour$/i.exec(label)) && (t = translated(N_("%s · %d hours"))))
    return fill(t, m[1], m[2]);
  if ((m = /^(.+?) weekly$/i.exec(label)) && (t = translated(N_("%s · weekly"))))
    return fill(t, m[1]);
  return label;
};

const money = (amount) => {
  try {
    return Number(amount).toLocaleString(uiLocale(), { style: "currency", currency: "USD" });
  } catch (e) {
    return `$${amount}`;
  }
};

/** Detail rows from the CLI ("$99.97 of $100.00 remaining", "Expires <ISO date>"). */
export const localizeDetail = (text, tr) => {
  if (!text) return text;
  let m;
  if ((m = /^\$([\d.,]+) of \$([\d.,]+) remaining$/i.exec(text))) {
    const parse = (s) => Number(s.replace(/,/g, ""));
    return fill(tr("%s of %s remaining"), money(parse(m[1])), money(parse(m[2])));
  }
  if ((m = /^Expires (\S+)$/i.exec(text))) {
    const date = new Date(m[1]);
    if (!Number.isNaN(date.getTime())) {
      const when = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      return fill(tr("Expires %s"), when);
    }
  }
  return tr(text);
};

/** Panel text: "5h 7% · 7d 6% in 3h 9min". */
export const formatPanelText = (usage, displayMode, elapsedSeconds, tr = (s) => s) => {
  if (!usage) return "";
  const parts = [];
  let resetSeconds = null;
  for (const tier of ["primary", "secondary"]) {
    const win = usage[tier];
    if (!win || win.usedPercent === undefined) continue;
    // Placeholder tiers (e.g. OpenRouter's balance) aren't usage windows.
    if (!win.windowSeconds && win.usedPercent === 0) continue;
    const used = Math.min(100, Math.max(0, parseFloat(win.usedPercent) || 0));
    const percent = Math.round(displayMode === "remaining" ? 100 - used : used);
    const hours = Math.round((win.windowSeconds || 0) / 3600);
    const label = !hours ? "" : hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
    parts.push(label ? `${label} ${percent}%` : `${percent}%`);
    if (resetSeconds === null) resetSeconds = (win.resetAfterSeconds || 0) - (elapsedSeconds || 0);
  }
  if (parts.length > 0) {
    let text = parts.join(" · ");
    if (resetSeconds > 0) text += fill(tr(" in %s"), formatDuration(resetSeconds));
    return text;
  }

  // Balance-only providers (e.g. DeepSeek) or plain provider cost.
  const balance = usage.primary?.resetDescription?.match(/^\$[0-9.]+/);
  if (balance) return balance[0];
  if (usage.providerCost && typeof usage.providerCost.used === "number") {
    const symbol = usage.providerCost.currencyCode === "USD" ? "$" : "";
    return `${symbol}${usage.providerCost.used.toFixed(2)}`;
  }
  return "";
};
