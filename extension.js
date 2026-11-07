// GNOME Shell extension entry point.
//
// Widget layout follows the macOS CodexBar menu: a strip of provider icons,
// the active provider's window meters, an optional balance block, a cost
// summary, then footer actions. Providers come from one `codexbar usage` call,
// so nothing is configured by hand.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";

import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { fetchCost, fetchUsage, findCodexBar } from "./cli.js";
import { parseUsagePayload } from "./parse.js";
import { formatMoney, formatTokens, parseCostPayload } from "./cost.js";
import { browserSessionMessage, validBrowserSessionError } from "./browser-status.js";
import {
  ADD_ACCOUNT_URL,
  CLI_REPO_URL,
  EXTENSION_REPO_URL,
  FORK_ORIGIN_EXTENSION_URL,
  FORK_ORIGIN_URL,
  INSTALL_URL,
  LICENSE_URL,
  statusUrl,
  usageUrl,
} from "./links.js";

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and a single extension stylesheet cannot
// ship separate light and dark foregrounds.
const SECONDARY_TEXT_OPACITY = 200;
const FAINT_TEXT_OPACITY = 150;

// Tab logos. Sized so the padded tab reads as a comfortable target, the way the
// macOS app spaces its provider strip.
const TAB_ICON_SIZE = 22;
const TAB_TRACK_WIDTH = TAB_ICON_SIZE;

// Panel indicator. The GNOME top panel is 32px tall with 16px icons. This bar
// was first far too tall (it inherited the panel height), then too small to read
// next to the system icons, so it sits in between: a bit wider than a symbol and
// about half the panel height, which is where the eye expects a meter.
const PANEL_BAR_WIDTH = 22;
const PANEL_BAR_HEIGHT = 9;
// 1px border per side, no padding.
const PANEL_BAR_INSET = 2;
// Popup bar track. The popup sets min-width 320px and the content box pads 12px
// per side, leaving this. Kept in sync with stylesheet.css.
const BAR_WIDTH_PX = 296;

/**
 * Dimmed label.
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function dimLabel(params) {
  const label = new St.Label({
    style_class: "codexbar-subtitle",
    ...params,
  });
  label.opacity = SECONDARY_TEXT_OPACITY;
  return label;
}

/**
 * "Resets in 3h 53m" from an absolute timestamp.
 * @param {string} iso
 * @param {Date} now
 * @returns {string} Empty when the timestamp is missing or already past.
 */
function formatResetsIn(iso, now = new Date()) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";

  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return _("Resets in %dd %dh").format(days, hours);
  if (hours > 0) return _("Resets in %dh %dm").format(hours, minutes);
  return _("Resets in %dm").format(minutes);
}

/**
 * "Updated just now" / "Updated 5m ago" / "Updated 2h ago".
 * @param {string} iso
 * @param {Date} now
 * @returns {string}
 */
function formatUpdated(iso, now = new Date()) {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return _("Updating...");
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return _("Updated just now");
  if (minutes < 60) return _("Updated %dm ago").format(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return _("Updated %dh ago").format(hours);
  return _("Updated %dd ago").format(Math.floor(hours / 24));
}

/**
 * True when a window is being consumed faster than its elapsed time allows.
 *
 * @param {object} window Normalized window from parse.js.
 * @returns {boolean}
 */
function isExceedingPace(window) {
  const pace = window?.pace;
  if (!pace) return false;

  // willLastToReset is the CLI's own verdict, but only the eta form carries it.
  // Fall back to comparing against the expected percentage, which is always
  // present, and treat an unknown stage as "no opinion" rather than a warning.
  if (pace.willLastToReset === true) return false;

  const expected = Number(pace.expectedUsedPercent);
  if (Number.isFinite(expected)) {
    return Number(window.usedPercent) > expected;
  }

  // No expected percentage: fall back to the stage names the CLI uses.
  return ["farAhead", "slightlyAhead", "ahead"].includes(pace.stage);
}

/**
 * Pace line, in the macOS wording. The CLI sends a ready-made summary, but it
 * is phrased for a terminal, so the stage and last-to-reset flags drive the
 * short popup line instead.
 * @param {object|null} pace
 * @param {number} usedPercent
 * @returns {string}
 */
function formatPace(pace, usedPercent) {
  if (!pace) return "";

  // Stages observed from the CLI: farAhead, slightlyAhead, ahead, behind,
  // slightlyBehind, farBehind.
  const lead = {
    farAhead: _("Well ahead"),
    slightlyAhead: _("Slightly ahead"),
    ahead: _("Ahead"),
    farBehind: _("Far behind"),
    slightlyBehind: _("Slightly behind"),
    behind: _("Behind"),
  }[pace.stage];

  const direction = Number(pace.deltaPercent) < 0 ? "-" : "+";
  const delta = Math.round(Math.abs(Number(pace.deltaPercent) || 0));
  const head = lead ? _("Pace: %s").format(lead) : _("Pace: %d%%").format(usedPercent);
  const tail = lastsWord(pace.willLastToReset, direction, delta);
  return `${head} · ${tail}`;
}

function formatCodexPace(pace) {
  const summary = typeof pace?.summary === "string" ? pace.summary.split("|")[0].trim() : "";
  return summary ? _("Pace: %s").format(summary) : "";
}

function formatCodexDetails(provider) {
  const lines = [];
  if (Number.isFinite(provider.creditsRemaining) && provider.creditsRemaining > 0) {
    lines.push(_("Credits: %d left").format(provider.creditsRemaining));
  }
  if (Number.isFinite(provider.resetCreditsAvailable) && provider.resetCreditsAvailable > 0) {
    lines.push(_("Limit Reset Credits: %d available").format(provider.resetCreditsAvailable));
  }
  if (typeof provider.plan === "string" && provider.plan) {
    const plan = provider.plan[0].toUpperCase() + provider.plan.slice(1);
    lines.push(_("Plan: %s").format(plan));
  }
  return lines;
}

/**
 * @param {unknown} willLastToReset
 * @param {string} direction "+" or "-".
 * @param {number} delta
 * @returns {string}
 */
function lastsWord(willLastToReset, direction, delta) {
  return willLastToReset === true
    ? _("%s%d%% · Lasts to reset").format(direction, delta)
    : _("%s%d%% · May run out").format(direction, delta);
}

/**
 * Threshold colour for a fill percentage. Matches the macOS app: blue while
 * there is room, amber then red as a window runs out.
 * @param {number} percent
 * @returns {string} Adwaita palette colour.
 */
function barColor(percent) {
  if (percent >= 90) return "#e01b24";
  if (percent >= 75) return "#ff7800";
  if (percent >= 50) return "#f6d32d";
  return "#3584e4";
}

/**
 * Pixel width for a fill inside a track of `trackWidth`.
 *
 * Tracks are plain St.Widgets with no layout manager, so a CSS percentage width
 * resolves against an unallocated parent and the fill renders at zero width.
 * Track widths are fixed constants (see BAR_WIDTH_PX) and fills are computed
 * from them, so no measurement is needed.
 *
 * @param {number} trackWidth Track width in pixels.
 * @param {number} percent 0 to 100.
 * @param {number} inset Pixels reserved by the track's border and padding.
 * @returns {number} At least 1, so a tiny usage still shows.
 */
function fillWidth(trackWidth, percent, inset = 0) {
  const inner = Math.max(1, trackWidth - inset);
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.max(1, Math.round((inner * clamped) / 100));
}

function activeProviderIndex(providers, currentIndex) {
  if (providers[currentIndex] && providers[currentIndex].kind !== "error") {
    return currentIndex;
  }
  const available = providers.findIndex((provider) => provider.kind !== "error");
  return available < 0
    ? Math.max(0, Math.min(currentIndex, providers.length - 1))
    : available;
}

function validBrowserSummary(data, profile, now = Date.now()) {
  const age = (now - Date.parse(data?.updatedAt)) / 1000;
  if (data?.source !== profile || !Number.isFinite(age) || age < 0 || age > 3600) return false;
  if (data?.status === "error") return validBrowserSessionError(data, profile, data.provider, now);
  // Field-level shape is owned by the helper that writes the cache; the shell
  // only checks freshness, profile scope, and that a provider tag is present.
  return typeof data.provider === "string";
}

function validConsoleUsage(usage) {
  const fields = ["totalRequests", "totalInputTokens", "totalOutputTokens", "totalCacheReadTokens",
    "totalCacheWrite5mTokens", "totalCacheWrite1hTokens", "totalCostMicroCents"];
  const safe = (value) => Number.isSafeInteger(value) && value >= 0;
  return usage?.summary && fields.every((key) => safe(usage.summary[key])) &&
    (!usage.hours || (Array.isArray(usage.hours) && usage.hours.length <= 25 && usage.hours.every((hour) =>
      typeof hour.date === "string" && safe(hour.cost) && safe(hour.tokens) && safe(hour.requests)))) &&
    (!usage.models || (Array.isArray(usage.models) && usage.models.length <= 10 && usage.models.every((model) =>
      typeof model.model === "string" && model.model.length <= 100 && safe(model.cost))));
}

function validHistoryDays(days, field) {
  return Array.isArray(days) && days.length <= 30 && days.every((day, index) => {
    if (!day || typeof day !== "object") return false;
    const parsed = typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
      ? new Date(`${day.date}T00:00:00Z`) : null;
    const date = parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day.date;
    return date && (index === 0 || day.date > days[index - 1].date) &&
      typeof day[field] === "number" && Number.isFinite(day[field]) && day[field] >= 0 && day[field] <= Number.MAX_SAFE_INTEGER;
  });
}

function validActivityHistory(history) {
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  return history && typeof history.periodLabel === "string" && history.periodLabel.length <= 80 &&
    count(history.todayTokens) && count(history.periodTokens) && validHistoryDays(history.daily, "tokens") &&
    history.daily.every((day) => count(day.tokens));
}

function validCreditHistory(history) {
  const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  return history && typeof history.periodLabel === "string" && history.periodLabel.length <= 80 &&
    count(history.todayCredits) && count(history.periodCredits) && validHistoryDays(history.daily, "credits") &&
    Array.isArray(history.events) && history.events.length <= 10 && history.events.every((event) =>
      event && validHistoryDays([{ date: event.date, credits: event.credits }], "credits") &&
      typeof event.service === "string" && event.service.length <= 100 && count(event.credits)) &&
    typeof history.eventsPartial === "boolean";
}

function historyDayDetail(date, value, label) {
  const daily = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const stamp = new Date(daily ? `${date}T00:00:00Z` : date);
  const options = daily ? { month: "short", day: "numeric", timeZone: "UTC" } :
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  const compact = Number.isFinite(stamp.getTime()) ? new Intl.DateTimeFormat(undefined, options).format(stamp) : date;
  return _("%s · %s").format(compact, label(value));
}

function nonzeroDetails(parts) {
  return parts.filter(([value]) => Number.isFinite(value) && value > 0).map(([, text]) => text).join(" · ");
}

function browserHelperNotice(enabled, profile, data, now = Date.now()) {
  if (!enabled) return "";
  if (!profile) return _("Choose a browser profile in Settings to enable browser usage.");
  if (!validBrowserSummary(data, profile, now)) return _("No recent browser usage. Check the helper service in Settings.");
  return "";
}

export default class CodexBarExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);

    // Panel indicator: a bar that fills as the primary provider burns through
    // its worst window, matching the macOS menu bar icon. Height is set here
    // rather than only in CSS because the panel button stretches its child to
    // the full 32px panel height, which is what made the bar tower over its
    // neighbours.
    this._panelTrack = new St.BoxLayout({
      style_class: "codexbar-panel-track",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      height: PANEL_BAR_HEIGHT,
      width: PANEL_BAR_WIDTH,
    });
    this._panelFill = new St.Widget({
      style_class: "codexbar-panel-fill",
      height: PANEL_BAR_HEIGHT - PANEL_BAR_INSET,
      width: 1,
      x_align: Clutter.ActorAlign.START,
    });
    this._panelTrack.add_child(this._panelFill);
    this._panelIcon = this._panelTrack;
    this._indicator.add_child(this._panelTrack);

    this._tabsBox = new St.BoxLayout({ style_class: "codexbar-tabs" });
    this._contentBox = new St.BoxLayout({
      style_class: "codexbar-content",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    // The section's own actor has to join the menu box: addMenuItem fills the
    // section's box, which renders only when the section is in the tree.
    this._footerBox = new PopupMenu.PopupMenuSection();
    this._historyBox = new PopupMenu.PopupMenuSection();
    this._indicator.menu.box.add_child(this._tabsBox);
    this._indicator.menu.box.add_child(this._contentBox);
    this._indicator.menu.addMenuItem(this._historyBox);
    this._indicator.menu.box.add_child(this._footerBox.actor);

    this._providers = [];
    this._activeIndex = 0;
    this._cost = null;
    this._browserSummaries = {};
    this._browserLoadGeneration = 0;
    this._stale = false;
    this._error = null;
    this._refreshing = false;
    this._cancellable = null;

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._settings.connectObject(
      "changed::refresh-interval",
      () => this._setupTimer(),
      "changed::show-pace",
      () => this._updateUI(),
      "changed::primary-provider",
      () => this._updateUI(),
      "changed::show-browser-summary",
      () => { this._loadBrowserSummary(); this._updateUI(); },
      "changed::browser-profile",
      () => { this._loadBrowserSummary(); this._updateUI(); },
      this,
    );

    this._indicator.menu.connect("open-state-changed", (_menu, isOpen) => {
      if (isOpen) {
        this._loadBrowserSummary();
        this._updateUI();
      }
    });

    this._buildFooter();
    this._loadBrowserSummary();
    this._setupTimer();
    this._startTick();
    this._refresh();
  }

  disable() {
    this._clearTimer();
    this._closeAbout();
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }
    if (this._tickId) {
      GLib.Source.remove(this._tickId);
      this._tickId = null;
    }
    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
    }
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._tabsBox = null;
    this._contentBox = null;
    this._footerBox = null;
    this._historyBox = null;
    this._panelTrack = null;
    this._panelFill = null;
    this._providers = [];
    this._browserSummaries = {};
    this._browserLoadGeneration++;
    this._refreshing = false;
  }

  _clearTimer() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }

  _loadBrowserSummary() {
    const generation = ++this._browserLoadGeneration;
    if (!this._settings?.get_boolean("show-browser-summary")) {
      this._browserSummaries = {};
      return;
    }
    const profile = this._settings.get_string("browser-profile");
    this._browserSummaries = Object.fromEntries(
      Object.entries(this._browserSummaries).filter(([provider, data]) => data?.provider === provider && validBrowserSummary(data, profile)),
    );
    for (const provider of ["deepseek", "opencodego", "codex"]) {
      const name = `browser-usage-${provider}.json`;
      const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), "codexbar", name]));
      file.load_contents_async(null, (source, result) => {
        try {
          const bytes = source.load_contents_finish(result)[1];
          if (!this._indicator || generation !== this._browserLoadGeneration ||
              !this._settings?.get_boolean("show-browser-summary") ||
              profile !== this._settings.get_string("browser-profile")) return;
          const data = JSON.parse(new TextDecoder().decode(bytes));
          if (data.provider !== provider || !validBrowserSummary(data, profile)) {
            delete this._browserSummaries[provider];
            if (this._indicator.menu.isOpen) this._updateUI();
            return;
          }
          this._browserSummaries[provider] = data;
          if (this._indicator.menu.isOpen) this._updateUI();
        } catch (e) {
          // An absent or malformed optional cache does not affect CLI usage.
          if (this._indicator && generation === this._browserLoadGeneration &&
              this._settings?.get_boolean("show-browser-summary") && profile === this._settings.get_string("browser-profile")) {
            delete this._browserSummaries[provider];
            if (this._indicator.menu.isOpen) this._updateUI();
          }
        }
      });
    }
  }

  _setupTimer() {
    this._clearTimer();
    const minutes = this._settings.get_int("refresh-interval");
    if (minutes <= 0) return;
    this._timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      minutes * 60,
      () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  /**
   * Fetch usage and cost, then render. Keeps the previous data on screen if
   * the fetch fails, so a transient CLI error does not blank the popup.
   */
  async _refresh() {
    if (this._refreshing || !this._indicator) return;
    this._refreshing = true;
    this._cancellable = new Gio.Cancellable();

    try {
      const payload = await fetchUsage(this._cancellable);
      const { providers } = parseUsagePayload(payload);

      // Cost is a separate command that only supports some providers. A failure
      // here must not take the usage view down with it.
      let cost = null;
      try {
        cost = parseCostPayload(await fetchCost(this._cancellable));
      } catch (e) {
        cost = null;
      }

      if (this._cancellable?.is_cancelled() || !this._indicator) return;

      this._activeIndex = activeProviderIndex(providers, this._activeIndex);
      this._providers = providers;
      this._loadBrowserSummary();
      this._cost = cost;
      this._error = null;
      this._stale = false;
      if (this._activeIndex >= providers.length) this._activeIndex = 0;
      try {
        this._updateUI();
      } catch (uiError) {
        console.error(`[CodexBar] _updateUI failed: ${uiError}`);
      }
    } catch (e) {
      if (this._cancellable?.is_cancelled() || !this._indicator) return;
      this._error = e.message || String(e);
      this._stale = this._providers.length > 0;
      try {
        this._updateUI();
      } catch (uiError) {
        console.error(`[CodexBar] _updateUI failed: ${uiError}`);
      }
    } finally {
      this._refreshing = false;
    }
  }

  /**
   * Re-render once a minute so "Resets in ..." and "Updated ..." count down
   * between fetches.
   */
  _startTick() {
    if (this._tickId) GLib.Source.remove(this._tickId);
    this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._loadBrowserSummary();
      this._updatePanelIcon();
      if (this._indicator?.menu.isOpen) this._updateUI();
      return GLib.SOURCE_CONTINUE;
    });
  }

  /**
   * The provider the panel bar tracks. Falls back to the first provider with
   * usage data when the configured one is missing or erroring.
   * @returns {object|null}
   */
  _primaryProvider() {
    if (this._providers.length === 0) return null;
    const wanted = this._settings?.get_string("primary-provider") || "";
    if (wanted) {
      const match = this._providers.find((p) => p.id === wanted && p.kind !== "error");
      if (match) return match;
    }
    return this._providers.find((p) => p.kind !== "error") || this._providers[0];
  }

  /**
   * Worst usage across a provider's meters.
   * @param {object} provider
   * @returns {number} 0 to 100.
   */
  _worstPercent(provider) {
    const meters = provider.windows?.filter((w) => w.meter) || [];
    if (meters.length === 0) return 0;
    return Math.max(...meters.map((w) => w.usedPercent));
  }

  _updatePanelIcon() {
    if (!this._panelFill) return;

    const provider = this._primaryProvider();
    const percent = provider ? this._worstPercent(provider) : 0;

    // Pixel widths, not percentages: the track has no layout manager, so a
    // percentage fill would resolve against an unallocated parent and vanish.
    this._panelFill.set_width(fillWidth(PANEL_BAR_WIDTH, percent, PANEL_BAR_INSET));
    this._panelFill.set_style(`background-color: ${barColor(percent)};`);

    this._panelTrack.opacity = this._stale || this._error ? FAINT_TEXT_OPACITY : 255;
    this._panelTrack.accessible_name = provider
      ? _("%s: %d%% used").format(provider.name, percent)
      : _("CodexBar");
  }

  /**
   * Provider logo as an St.Icon, falling back to a letter tile for providers
   * with no bundled logo.
   * @param {object} provider
   * @param {number} size
   * @returns {St.Widget}
   */
  _providerIcon(provider, size) {
    const path = GLib.build_filenamev([
      this.path,
      "media",
      "logos",
      `${provider.id}-symbolic.svg`,
    ]);

    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
      return new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        icon_size: size,
        style_class: "codexbar-provider-icon",
      });
    }

    // No logo: a letter tile keeps the strip evenly spaced and still tells the
    // providers apart at a glance.
    const initial = (provider.name || provider.id || "?").trim().charAt(0).toUpperCase();
    return new St.Label({
      text: initial,
      style_class: "codexbar-provider-letter",
      y_align: Clutter.ActorAlign.CENTER,
      width: size,
      height: size,
    });
  }

  _buildFooter() {
    const providerId = () => this._providers[this._activeIndex]?.id || "";

    const add = (label, iconName, onActivate) => {
      const item = new PopupMenu.PopupMenuItem(label, {
        style_class: "codexbar-action",
      });
      if (iconName) {
        item.add_child(
          new St.Icon({
            icon_name: iconName,
            style_class: "popup-menu-icon codexbar-action-icon",
          }),
        );
      }
      item.connect("activate", onActivate);
      this._footerBox.addMenuItem(item);
    };

    const open = (uri) => () => {
      Gio.AppInfo.launch_default_for_uri(uri, null);
      this._indicator.menu.close();
    };

    add(_("Add Account..."), "list-add-symbolic", open(ADD_ACCOUNT_URL));
    add(_("Usage Dashboard"), "view-list-symbolic", () => open(usageUrl(providerId()))());
    add(_("Status Page"), "network-transmit-receive-symbolic", () => open(statusUrl(providerId()))());
    add(_("Refresh Now"), "view-refresh-symbolic", () => {
      this._indicator.menu.close();
      this._refresh();
    });
    add(_("Settings..."), "preferences-system-symbolic", () => {
      this._indicator.menu.close();
      this.openPreferences();
    });

    this._footerBox.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // No Quit item: this is an extension, not an application, so there is no
    // process to exit. Disabling is the shell's job, via the Extensions app or
    // `gnome-extensions disable`.
    add(_("About CodexBar"), "help-about-symbolic", () => {
      this._indicator.menu.close();
      this._showAbout();
    });
  }

  _showAbout() {
    if (this._aboutDialog) {
      return;
    }

    let meta;
    try {
      meta = JSON.parse(
        new TextDecoder().decode(
          GLib.file_get_contents(
            GLib.build_filenamev([this.path, "metadata.json"]),
          )[1],
        ),
      );
    } catch (e) {
      console.error(`[CodexBar] could not read metadata.json: ${e}`);
      return;
    }

    const dialog = new ModalDialog({
      // shellReactive omits the shell's dimming lightbox.
      shellReactive: true,
      shouldFadeIn: false,
      shouldFadeOut: false,
    });
    const text = new St.Label({
      text: `${meta.name} — ${_("Version")} ${meta.version}\n\n` + _(
        "Fork of the extension by @inled.es (extension 9841).\n" +
        "Provider logos from CodexBar. MIT licence.",
      ),
    });
    text.clutter_text.line_wrap = true;
    dialog.contentLayout.add_child(text);

    for (const [label, url] of [
      [_("This extension"), EXTENSION_REPO_URL],
      [_("codexbar CLI"), CLI_REPO_URL],
      [_("Upstream extension"), FORK_ORIGIN_URL],
      [_("Upstream on extensions.gnome.org"), FORK_ORIGIN_EXTENSION_URL],
      [_("License"), LICENSE_URL],
    ]) {
      const link = new St.Button({ label, style_class: "shell-link" });
      link.connect("clicked", () => {
        try {
          Gio.AppInfo.launch_default_for_uri(url, null);
          dialog.close();
        } catch (e) {
          console.error(`[CodexBar] could not open ${url}: ${e}`);
        }
      });
      dialog.contentLayout.add_child(link);
    }
    dialog.setButtons([{
      label: _("Close"),
      action: () => dialog.close(),
      key: Clutter.KEY_Escape,
    }]);
    this._aboutDialog = dialog;
    dialog.connect("destroy", () => { this._aboutDialog = null; });
    if (!dialog.open()) this._closeAbout();
  }

  _closeAbout() {
    this._aboutDialog?.close();
    this._aboutDialog?.destroy();
    this._aboutDialog = null;
  }

  _updateUI() {
    if (!this._contentBox) return;
    this._updatePanelIcon();

    this._tabsBox.destroy_all_children();
    this._contentBox.destroy_all_children();
    this._historyBox.removeAll();

    if (!findCodexBar()) {
      this._contentBox.add_child(this._messageBox(
        _("codexbar not found"),
        _("Install it, then refresh. See %s").replace("%s", INSTALL_URL),
      ));
      return;
    }

    if (this._error && this._providers.length === 0) {
      this._contentBox.add_child(this._messageBox(_("Could not read usage"), this._error));
      return;
    }

    if (this._providers.length === 0) {
      this._contentBox.add_child(this._messageBox(
        _("No providers enabled"),
        _("Enable a provider in CodexBar, then refresh."),
      ));
      return;
    }

    this._buildTabs();

    const provider = this._providers[this._activeIndex];
    if (!provider) return;

    if (provider.kind === "error") {
      this._contentBox.add_child(this._messageBox(provider.name, provider.error));
      return;
    }

    // The tab icons carry identity, so no repeated provider-name header here.
    // The account and update stamp go on one compact line instead.
    const meta = new St.BoxLayout({ x_expand: true });
    const stamp = formatUpdated(provider.updatedAt) || _("Updating...");
    if (provider.account) {
      meta.add_child(dimLabel({
        text: `${stamp} · ${provider.account}`,
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
      }));
    } else {
      meta.add_child(dimLabel({ text: stamp, x_expand: true }));
    }
    this._contentBox.add_child(meta);

    if (this._stale) {
      const stale = dimLabel({ text: _("Showing last known values") });
      stale.opacity = FAINT_TEXT_OPACITY;
      this._contentBox.add_child(stale);
    }

    for (const window of provider.windows) {
      this._contentBox.add_child(
        window.meter ? this._buildMeter(window, provider.id === "codex") : this._buildBalance(window),
      );
    }

    if (provider.id === "codex") {
      for (const text of formatCodexDetails(provider)) {
        this._contentBox.add_child(dimLabel({ text }));
      }
    }
    if (provider.plan && provider.id !== "codex") {
      const plan = provider.plan[0].toUpperCase() + provider.plan.slice(1);
      this._contentBox.add_child(dimLabel({ text: _("Plan: %s").format(plan) }));
    }

    for (const section of provider.details || []) {
      if (section.rows.length) {
        this._contentBox.add_child(new St.Label({ text: section.title, style_class: "codexbar-section" }));
        for (const row of section.rows) {
          const details = [row.value, row.secondaryValue].filter(Boolean).join(" · ");
          this._contentBox.add_child(dimLabel({ text: `${row.label}: ${details}`, width: BAR_WIDTH_PX }));
        }
      }
      if (section.chart) {
        const item = new PopupMenu.PopupSubMenuMenuItem(section.chart.title);
        this._addChartToMenu(item.menu, section.chart.points.map((point) => ({ date: point.label, value: point.value })),
          "value", formatTokens);
        this._historyBox.addMenuItem(item);
      }
    }

    if (this._cost?.providers?.some((entry) => entry.id === provider.id &&
        [entry.todayCost, entry.todayTokens, entry.cost, entry.tokens].some((value) => value > 0))) {
      this._contentBox.add_child(this._buildCost(provider.id));
    }

    const profile = this._settings.get_string("browser-profile");
    const cachedBrowserSummary = this._browserSummaries?.[provider.id];
    const browserSummary = validBrowserSummary(cachedBrowserSummary, profile) ? cachedBrowserSummary : null;
    if (["deepseek", "codex", "opencodego"].includes(provider.id)) {
      const notice = browserHelperNotice(this._settings.get_boolean("show-browser-summary"), profile, browserSummary);
      if (notice) {
        const label = dimLabel({ text: notice, width: BAR_WIDTH_PX });
        label.clutter_text.line_wrap = true;
        this._contentBox.add_child(label);
      }
    }
    if (browserSummary?.status === "error") {
      const label = dimLabel({ text: browserSessionMessage(browserSummary, _), width: BAR_WIDTH_PX });
      label.clutter_text.line_wrap = true;
      this._contentBox.add_child(label);
    }
    if (provider.id === "deepseek" && browserSummary?.status !== "error" && browserSummary?.provider === "deepseek") {
      this._contentBox.add_child(this._buildBrowserSummary(browserSummary));
      this._addHistorySubmenu(_("Usage history · %s").format(browserSummary.periodLabel), browserSummary.daily || [], [
        { field: "cost", label: _("Spend"), format: (v) => this._browserMoney(browserSummary, v) },
        { field: "tokens", label: _("Tokens"), format: formatTokens },
      ]);
    }
    if (provider.id === "codex" && browserSummary?.status !== "error" && browserSummary?.provider === "codex") {
      const expected = typeof provider.account === "string" ? provider.account.trim().toLowerCase() : "";
      const expectedHash = expected ? GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, expected, -1) : null;
      if (!expected || (expectedHash && expectedHash === browserSummary.emailHash)) {
        this._contentBox.add_child(this._buildBrowserWindows(
          browserSummary.extraWindows || [], _("Codex web additional limits")));
        if (Number.isFinite(browserSummary.credits) && browserSummary.credits > 0) {
          this._contentBox.add_child(dimLabel({ text: _("Web credits: %s").format(browserSummary.credits.toFixed(2)) }));
        }
        this._addCodexHistory(browserSummary);
        if (browserSummary.historyStatus === "requires-webkit-dashboard") {
          this._contentBox.add_child(dimLabel({ text: _("Codex web usage history requires the upstream WebKit dashboard and is unavailable here") }));
        }
        for (const [history, valid, todayKey, periodKey, label, format] of [
          [browserSummary.activityHistory, validActivityHistory, "todayTokens", "periodTokens", _("Web tokens"), formatTokens],
          [browserSummary.creditHistory, validCreditHistory, "todayCredits", "periodCredits", _("Web credits"), (v) => v.toFixed(2)],
        ]) {
          if (!valid(history)) continue;
          const text = nonzeroDetails([[history[todayKey], _("%s today").format(format(history[todayKey]))],
            [history[periodKey], _("%s in last 30 days").format(format(history[periodKey]))]]);
          if (text) this._contentBox.add_child(dimLabel({ text: `${label}: ${text}` }));
        }
      }
    }
    if (provider.id === "opencodego" && browserSummary?.status !== "error" && browserSummary?.provider === "opencodego") {
      if (Number.isFinite(browserSummary.balanceUSD) && browserSummary.balanceUSD > 0) {
        this._contentBox.add_child(dimLabel({ text: _("Prepaid Zen balance: $%s").format(Number(browserSummary.balanceUSD).toFixed(2)) }));
      }
      if (browserSummary.consoleUsageError) {
        this._contentBox.add_child(dimLabel({ text: _(browserSummary.consoleUsageError) }));
      } else if (validConsoleUsage(browserSummary.consoleUsage)) {
        const usage = browserSummary.consoleUsage;
        const summary = usage.summary;
        const tokens = summary.totalInputTokens + summary.totalOutputTokens + summary.totalCacheReadTokens +
          summary.totalCacheWrite5mTokens + summary.totalCacheWrite1hTokens;
        const totals = nonzeroDetails([
          [summary.totalCostMicroCents, _("Reported cost: $%s").format((summary.totalCostMicroCents / 100_000_000).toFixed(2))],
          [tokens, _("%s tokens").format(formatTokens(tokens))], [summary.totalRequests, _("%s requests").format(formatTokens(summary.totalRequests))],
        ]);
        if (totals) {
          this._contentBox.add_child(dimLabel({ text: _("Console usage · last 24 hours (all organization usage)") }));
          this._contentBox.add_child(dimLabel({ text: totals }));
        }
        if (usage.hours?.length) this._addHistorySubmenu(_("Cost history (24 hours)"), usage.hours.map((h) => ({
          date: h.date, cost: h.cost / 100_000_000, tokens: h.tokens, requests: h.requests,
        })), [{ field: "cost", label: _("Reported cost"), format: (v) => `$${v.toFixed(2)}` }]);
        const models = (usage.models || []).filter((model) => model.cost > 0);
        if (models.length) {
          const item = new PopupMenu.PopupSubMenuMenuItem(_("Models · reported cost"));
          this._addChartToMenu(item.menu, models, "cost", (v) => `$${(v / 100_000_000).toFixed(2)}`, "model");
          if (usage.modelsPartial) item.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("Top 10 models only"), { reactive: false }));
          this._historyBox.addMenuItem(item);
        }
        if (usage.historyUnavailable) this._contentBox.add_child(dimLabel({ text: _("Usage history unavailable") }));
        if (totals) this._contentBox.add_child(dimLabel({ text: _("Reported Console usage; not out-of-pocket billing") }));
      }
    }

    // Bars are sized in pixels against the track, so the popup needs a fixed
    // width to fill. Without it the menu shrinks to the widest label.
    this._contentBox.set_style("min-width: 320px;");
    this._tabsBox.set_style("min-width: 320px;");
  }

  _buildTabs() {
    const primaryId = this._primaryProvider()?.id;

    this._providers.forEach((provider, index) => {
      const active = index === this._activeIndex;

      const button = new St.Button({
        style_class: active ? "codexbar-tab codexbar-tab-active" : "codexbar-tab",
        can_focus: true,
        accessible_name: provider.name,
      });

      const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        y_align: Clutter.ActorAlign.CENTER,
      });
      column.add_child(this._providerIcon(provider, TAB_ICON_SIZE));

      // The underline is the macOS touch: each tab carries its own load, so
      // you can see which provider needs attention without switching to it.
      // Balance providers have no usage meter, so they get a dim full-width
      // track rather than a misleading near-empty fill.
      // Error providers have no usage windows; leave their track empty.
      const isError = provider.kind === "error";
      const isBalance = provider.kind === "balance";
      const percent = isBalance || isError ? 0 : this._worstPercent(provider);
      const fillPercent = isBalance ? 100 : percent;

      const track = new St.BoxLayout({ style_class: "codexbar-tab-track" });
      if (!isError) {
        track.add_child(
          new St.Widget({
            style_class: isBalance
              ? "codexbar-tab-fill codexbar-tab-fill-balance"
              : "codexbar-tab-fill",
            style: `width: ${fillWidth(TAB_TRACK_WIDTH, fillPercent)}px; background-color: ${isBalance ? "#77767b" : barColor(percent)};`,
          }),
        );
      }
      column.add_child(track);
      button.set_child(column);

      button.connect("clicked", () => {
        this._activeIndex = index;
        this._updateUI();
      });
      this._tabsBox.add_child(button);

      // A dot marks which provider the panel bar is tracking.
      if (provider.id === primaryId && this._providers.length > 1) {
        this._tabsBox.add_child(
          new St.Widget({
            style_class: "codexbar-tab-primary-dot",
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
      }
    });
  }

  /**
   * A window with a duration or a reset time: title, bar, percent, countdown.
   * @param {object} window
   * @returns {St.BoxLayout}
   */
  _buildMeter(window, isCodex = false) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    box.add_child(new St.Label({ text: window.label, style_class: "codexbar-section" }));

    // A plain St.Widget, not a BoxLayout: the fill and the tick have to overlap
    // inside one track, and a BoxLayout would place them side by side, pushing
    // the tick past the end of the bar.
    const track = new St.Widget({ style_class: "codexbar-bar-track" });
    track.add_child(
      new St.Widget({
        style_class: "codexbar-bar-fill",
        x: 0,
        width: fillWidth(BAR_WIDTH_PX, window.usedPercent),
        style: `background-color: ${barColor(window.usedPercent)};`,
      }),
    );

    // A tick at the point where usage "should" be by now, so ahead and behind
    // read at a glance instead of having to compare two numbers.
    if (this._settings.get_boolean("show-pace")) {
      const expected = Number(window.pace?.expectedUsedPercent);
      if (Number.isFinite(expected) && expected > 0) {
        track.add_child(
          new St.Widget({
            style_class: "codexbar-bar-marker",
            x: fillWidth(BAR_WIDTH_PX, expected) - 1,
          }),
        );
      }
    }
    box.add_child(track);

    const row = new St.BoxLayout({ x_expand: true });
    row.add_child(dimLabel({ text: _("%d%% used").format(window.usedPercent) }));
    const resets = formatResetsIn(window.resetsAt);
    if (resets) {
      row.add_child(dimLabel({
        text: resets,
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
      }));
    }
    box.add_child(row);

    // Other providers only warn when over-consumed; Codex's compact summary
    // also reports its pace while on track.
    const codexPace = isCodex ? formatCodexPace(window.pace) : "";
    if (this._settings.get_boolean("show-pace") && (codexPace || isExceedingPace(window))) {
      const pace = codexPace || formatPace(window.pace, window.usedPercent);
      if (pace) {
        const paceLabel = dimLabel({ text: pace });
        paceLabel.opacity = FAINT_TEXT_OPACITY;
        box.add_child(paceLabel);
      }
    }

    box.add_child(new St.Widget({ style_class: "codexbar-separator" }));
    return box;
  }

  /**
   * A balance window has no duration and no reset, only a value. Rendering it
   * as a 0% bar would read as "exhausted", so it gets a value line instead.
   * @param {object} window
   * @returns {St.BoxLayout}
   */
  _buildBalance(window) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    box.add_child(new St.Label({ text: window.label, style_class: "codexbar-section" }));

    const row = new St.BoxLayout({ x_expand: true });
    row.add_child(dimLabel({ text: window.value || "-" }));
    row.add_child(dimLabel({
      text: _("%d%% used").format(window.usedPercent),
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
    }));
    box.add_child(row);

    box.add_child(new St.Widget({ style_class: "codexbar-separator" }));
    return box;
  }

  /**
   * The macOS cost summary: today and the last 30 days, cost and tokens.
   * @returns {St.BoxLayout}
   */
  _buildCost(providerId) {
    const providerCost = this._cost.providers.find((entry) => entry.id === providerId);
    if (!providerCost) return new St.Widget();
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    box.add_child(new St.Label({ text: _("Local cost estimate"), style_class: "codexbar-section" }));

    const row = (label, cost, tokens) => {
      const text = nonzeroDetails([[cost, formatMoney(cost, providerCost.currency)], [tokens, _("%s tokens").format(formatTokens(tokens))]]);
      if (!text) return;
      const line = new St.BoxLayout({ x_expand: true });
      line.add_child(dimLabel({
        text: `${label}: ${text}`,
      }));
      box.add_child(line);
    };

    row(_("Today"), providerCost.todayCost, providerCost.todayTokens);
    row(_("All time"), providerCost.cost, providerCost.tokens);
    return box;
  }

  _buildBrowserSummary(data) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    box.add_child(new St.Label({ text: _("Browser usage · %s").format(data.periodLabel), style_class: "codexbar-section" }));
    const line = (label, value) => {
      if (!value) return;
      const row = new St.BoxLayout({ x_expand: true });
      row.add_child(dimLabel({ text: label, x_expand: true }));
      row.add_child(dimLabel({ text: value, x_align: Clutter.ActorAlign.END }));
      box.add_child(row);
    };
    const money = (value) => this._browserMoney(data, value);
    const totals = (tokens, cost) => nonzeroDetails([[tokens, _("%s tokens").format(formatTokens(tokens))], [cost, money(cost)]]);
    line(_("Today"), totals(data.todayTokens, data.todayCost));
    const recent = (data.daily || []).slice(-7);
    if (recent.length) line(_("Last 7 days"), totals(recent.reduce((sum, day) => sum + day.tokens, 0), recent.reduce((sum, day) => sum + day.cost, 0)));
    line(data.periodLabel, totals(data.periodTokens, data.periodCost));
    line(_("Requests"), nonzeroDetails([[data.requestCount, _("%s today").format(formatTokens(data.requestCount))],
      [data.periodRequests, _("%s in period").format(formatTokens(data.periodRequests))]]));
    if (data.topModel) line(_("Top model"), data.topModel);
    box.add_child(dimLabel({ text: _("Experimental browser session data"), opacity: FAINT_TEXT_OPACITY }));
    return box;
  }

  _browserMoney(data, value) {
    return `${({ USD: "$", CNY: "¥" })[data.currency] || `${data.currency} `}${Number(value || 0).toFixed(2)}`;
  }

  _addHistorySubmenu(title, days, series) {
    series = series.filter(({ field }) => days.some((day) => day[field] > 0));
    if (!series.length) return;
    const item = new PopupMenu.PopupSubMenuMenuItem(title);
    for (const { field, label, format } of series) {
      item.menu.box.add_child(new St.Label({ text: label, style_class: "codexbar-section codexbar-history-inset" }));
      this._addChartToMenu(item.menu, days, field, format);
    }
    this._historyBox.addMenuItem(item);
  }

  _addCodexHistory(data) {
    const activityValid = validActivityHistory(data.activityHistory);
    const creditsValid = validCreditHistory(data.creditHistory);
    if ((!activityValid || data.activityHistory.periodTokens === 0) && (!creditsValid || data.creditHistory.periodCredits === 0) &&
        !data.activityHistoryError && !data.creditHistoryError) return;
    if (!activityValid && !creditsValid && !data.activityHistoryError && !data.creditHistoryError) return;
    const item = new PopupMenu.PopupSubMenuMenuItem(_("Codex web history"));
    const add = (title, history, field, format, error) => {
      const today = history?.[field === "tokens" ? "todayTokens" : "todayCredits"];
      const period = history?.[field === "tokens" ? "periodTokens" : "periodCredits"];
      if (!error && (!history || period === 0)) return;
      item.menu.box.add_child(new St.Label({ text: title, style_class: "codexbar-section codexbar-history-inset" }));
      if (error) {
        item.menu.box.add_child(dimLabel({ text: error, style_class: "codexbar-subtitle codexbar-history-inset" }));
        return;
      }
      if (!history) return;
      const line = dimLabel({ style_class: "codexbar-subtitle codexbar-history-inset", text: nonzeroDetails([[today, _("Today: %s").format(format(today))],
        [period, `${history.periodLabel}: ${format(period)}`]]) });
      item.menu.box.add_child(line);
      if (history.daily.length) {
        this._addChartToMenu(item.menu, history.daily, field, format);
      }
      if (field === "credits") {
        for (const event of history.events.filter((event) => event.credits > 0)) item.menu.box.add_child(dimLabel({ text: _("%s · %s credits").format(event.service, historyDayDetail(event.date, event.credits, format)), style_class: "codexbar-subtitle codexbar-history-inset" }));
        if (history.eventsPartial) item.menu.box.add_child(dimLabel({ text: _("Most recent events only"), style_class: "codexbar-subtitle codexbar-history-inset" }));
      }
    };
    add(_("Token activity"), activityValid ? data.activityHistory : null, "tokens", formatTokens, data.activityHistoryError || (!activityValid ? _("Token activity unavailable") : ""));
    add(_("Credits"), creditsValid ? data.creditHistory : null, "credits", (v) => `${Number(v).toFixed(2)}`, data.creditHistoryError || (!creditsValid ? _("Credit history unavailable") : ""));
    this._historyBox.addMenuItem(item);
  }

  _addChartToMenu(menu, days, field, format, labelField = "date") {
    const detail = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, width: BAR_WIDTH_PX, x_expand: true, style_class: "codexbar-history-detail" });
    const primaryDetail = dimLabel({ style_class: "codexbar-subtitle codexbar-history-detail", text: labelField === "model" ? _("Hover or focus a model for details") : _("Hover or focus a bar for details"), x_expand: true });
    primaryDetail.clutter_text.line_wrap = false;
    primaryDetail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    const secondaryDetail = dimLabel({ style_class: "codexbar-subtitle codexbar-history-detail", text: "\u00a0", x_expand: true });
    secondaryDetail.clutter_text.line_wrap = false;
    secondaryDetail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    detail.add_child(primaryDetail);
    detail.add_child(secondaryDetail);
    menu.box.add_child(detail);
    const maximum = Math.max(0, ...days.map((day) => day[field]));
    const row = new St.BoxLayout({ width: BAR_WIDTH_PX, x_expand: true, y_align: Clutter.ActorAlign.END, style_class: "codexbar-history-chart" });
    row.layout_manager.homogeneous = true;
    days.forEach((day) => {
      const description = labelField === "model" ? _("%s · %s").format(day.model, format(day[field])) : historyDayDetail(day.date, day[field], format);
      const supplemental = [
        ...(field !== "tokens" && day.tokens > 0 ? [_('%s tokens').format(formatTokens(day.tokens))] : []),
        ...(day.requests > 0 ? [_('%s requests').format(formatTokens(day.requests))] : []),
      ].join(" · ");
      const accessibleDescription = [description, supplemental].filter(Boolean).join(" · ");
      const button = new St.Button({ can_focus: true, x_expand: true, style_class: "codexbar-history-day",
        accessible_name: accessibleDescription });
      button.set_child(new St.Widget({ style_class: "codexbar-history-bar",
        x_expand: true, x_align: Clutter.ActorAlign.FILL,
        height: maximum ? Math.max(2, Math.round(48 * day[field] / maximum)) : 2, y_align: Clutter.ActorAlign.END }));
      const show = () => {
        primaryDetail.text = description;
        secondaryDetail.text = supplemental || "\u00a0";
      };
      button.connect("clicked", show);
      button.connect("enter-event", show);
      button.connect("key-focus-in", show);
      row.add_child(button);
    });
    menu.box.add_child(row);
  }

  _buildBrowserWindows(windows, title) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    if (!windows.length) return box;
    box.add_child(new St.Label({ text: title, style_class: "codexbar-section" }));
    for (const window of windows) {
      const row = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
      row.add_child(dimLabel({ text: window.label }));
      const track = new St.Widget({ style_class: "codexbar-bar-track", width: BAR_WIDTH_PX, height: 8 });
      const percent = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
      track.add_child(new St.Widget({
        style_class: "codexbar-bar-fill",
        width: fillWidth(BAR_WIDTH_PX, percent),
        height: 8,
        x: 0,
        style: `background-color: ${barColor(percent)};`,
      }));
      track.accessible_name = _("%s: %d%% used").format(window.label, percent);
      row.add_child(track);
      row.add_child(dimLabel({ text: _("%d%% used").format(percent) }));
      box.add_child(row);
    }
    return box;
  }

  /**
   * @param {string} title
   * @param {string} detail
   * @returns {St.BoxLayout}
   */
  _messageBox(title, detail) {
    const box = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
    box.add_child(new St.Label({ text: title, style_class: "codexbar-section" }));
    const detailLabel = dimLabel({ text: detail });
    detailLabel.clutter_text.line_wrap = true;
    box.add_child(detailLabel);
    return box;
  }
}
