
// Main extension skeleton: panel indicator, popup menu and refresh loop.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";
import {
  calculateUsagePace,
  deriveCreditsPercent,
  normalizeDetailSections,
  UsageApiClient,
} from "./usageApi.js";
import { loadToken, nullTokenSchema } from "./secret.js";
import {
  mergeDiscoveredProviders,
} from "./providerCatalog.js";
import { discoverEnabledProviders } from "./providerDiscovery.js";
import { PREDEFINED_PROVIDERS } from "./providerSources.js";
import { formatMoney, formatTokens, parseCostPayload } from "./cost.js";
import {
  CLI_REPO_URL,
  EGO_URL,
  EXTENSION_REPO_URL,
  LICENSE_URL,
  statusUrl,
  usageUrl,
} from "./links.js";
import {
  applyLanguage,
  currentLanguage,
  formatPanelText,
  formatPercent,
  formatReset,
  localizeDetail,
  localizeLabel,
  setCatalog,
  tr as _,
} from "./localize.js";

// Debug trace is opt-in: set CODEXBAR_DEBUG=1 before starting the shell
// (e.g. `CODEXBAR_DEBUG=1 gnome-shell --devkit`) to enable it.
function logDev(msg) {
  if (GLib.getenv("CODEXBAR_DEBUG")) console.debug(`[CodexBar] ${msg}`);
}

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and the shell dims text with per-theme
// `rgba()` foregrounds only because it ships separate light and dark
// stylesheets — an extension with a single stylesheet cannot.
const SECONDARY_TEXT_OPACITY = 200;

// Width of the per-tab load underline. The fill is sized in pixels against it.
const TAB_TRACK_WIDTH = 44;

/**
 * Build a dimmed secondary label.
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function subtitleLabel(params) {
  const label = new St.Label({
    style_class: "codexbar-usage-subtitle",
    ...params,
  });
  label.opacity = SECONDARY_TEXT_OPACITY;
  return label;
}

/**
 * Main extension class for CodexBar.
 */
export default class CodexBarExtension extends Extension {
  /**
   * Called when the extension is enabled.
   * Se llama cuando la extensión se activa.
   */
  enable() {
    this._settings = this.getSettings();
    this._apiClient = new UsageApiClient(this.path);
    this._copyTimeouts = [];

    this._applyLanguage();
    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);

    this._iconBox = new St.BoxLayout({
      style_class: "codexbar-panel-icon-box",
      orientation: Clutter.Orientation.HORIZONTAL,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._iconFill = new St.Widget({
      style_class: "codexbar-panel-icon-fill",
      x_expand: false,
      y_align: Clutter.ActorAlign.CENTER,
      width: 0,
    });
    this._iconBox.add_child(this._iconFill);

    // Per-provider text ("5h 3% · W 22% in 3h 15m"), shown instead of the
    // bar when any provider is flagged showInPanel.
    this._panelTextBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      y_align: Clutter.ActorAlign.CENTER,
      visible: false,
    });
    this._panelBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
    });
    this._panelBox.add_child(this._iconBox);
    this._panelBox.add_child(this._panelTextBox);
    // Numeric percentage beside the battery icon; meaning follows display-mode.
    this._percentLabel = new St.Label({
      text: "",
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "codexbar-panel-percent",
      visible: false,
    });
    this._panelBox.add_child(this._percentLabel);
    this._indicator.add_child(this._panelBox);

    this._headerBox = new St.BoxLayout({
      style_class: "codexbar-header",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
    });
    this._headerTitle = new St.Label({
      text: _("CodexBar"),
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    this._headerBox.add_child(this._headerTitle);

    const refreshContent = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._refreshIcon = new St.Icon({
      icon_name: "view-refresh-symbolic",
      icon_size: 16,
    });
    // A tiny rotating glyph keeps the button useful while the CLI runs; St
    // has no spinner widget of its own.
    this._refreshSpinner = new St.Label({
      text: "◐",
      style_class: "codexbar-refresh-spinner",
      visible: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    refreshContent.add_child(this._refreshIcon);
    refreshContent.add_child(this._refreshSpinner);

    this._refreshBtn = new St.Button({
      child: refreshContent,
      style_class: "codexbar-header-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._refreshBtn.connect("clicked", () => this._requestRefresh());
    this._headerBox.add_child(this._refreshBtn);

    let settingsBtn = new St.Button({
      child: new St.Icon({
        icon_name: "preferences-system-symbolic",
        icon_size: 16,
      }),
      style_class: "codexbar-header-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    settingsBtn.connect("clicked", () => {
      this.openPreferences();
      this._indicator.menu.close();
    });
    this._headerBox.add_child(settingsBtn);

    this._indicator.menu.box.add_child(this._headerBox);
    this._indicator.menu.box.add_style_class_name("codexbar-popup");

    // Provider tabs are housed in a horizontal St.ScrollView so they don't
    // overflow the popup when multiple providers are configured.
    this._tabsScroll = new St.ScrollView({
      style_class: "codexbar-tabs-scroll",
      hscrollbar_policy: St.PolicyType.AUTOMATIC,
      vscrollbar_policy: St.PolicyType.NEVER,
      enable_mouse_scrolling: true,
      overlay_scrollbars: true,
      x_expand: true,
      clip_to_allocation: true,
      reactive: true,
    });

    const setScrollbarVisible = (visible) => {
      const hscroll = this._tabsScroll
        ?.get_children()
        ?.find(
          (c) =>
            c instanceof St.ScrollBar &&
            c.get_orientation() === Clutter.Orientation.HORIZONTAL,
        );
      if (!hscroll) return;

      const hadj = this._tabsScroll.get_hadjustment();
      const canScroll = hadj && hadj.upper > hadj.page_size + 1;
      const shouldShow = visible && canScroll;

      hscroll.remove_all_transitions();
      hscroll.ease({
        opacity: shouldShow ? 255 : 0,
        duration: 200,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      });
      hscroll.reactive = shouldShow;

      if (shouldShow) {
        this._tabsScroll.add_style_class_name("hover");
      } else {
        this._tabsScroll.remove_style_class_name("hover");
      }
    };

    const initialHScroll = this._tabsScroll
      .get_children()
      .find(
        (c) =>
          c instanceof St.ScrollBar &&
          c.get_orientation() === Clutter.Orientation.HORIZONTAL,
      );
    if (initialHScroll) {
      initialHScroll.opacity = 0;
      initialHScroll.reactive = false;
    }

    this._tabsScroll.connect("enter-event", (_actor, event) => {
      const related = event.get_related();
      if (!related || !this._tabsScroll.contains(related)) {
        setScrollbarVisible(true);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._tabsScroll.connect("leave-event", (_actor, event) => {
      const related = event.get_related();
      if (!related || !this._tabsScroll.contains(related)) {
        setScrollbarVisible(false);
      }
      return Clutter.EVENT_PROPAGATE;
    });

    this._tabsScroll.connect("notify::hover", () => {
      setScrollbarVisible(this._tabsScroll.hover);
    });

    this._tabsScroll.connect("scroll-event", (_actor, event) => {
      setScrollbarVisible(true);
      const hadj = this._tabsScroll.get_hadjustment();
      if (!hadj) return Clutter.EVENT_PROPAGATE;

      const dir = event.get_scroll_direction();
      if (dir === Clutter.ScrollDirection.SMOOTH) {
        const [dx, dy] = event.get_scroll_delta();
        if (dx !== 0 || dy !== 0) {
          hadj.adjust_for_scroll_event(dx !== 0 ? dx : dy);
          return Clutter.EVENT_STOP;
        }
      } else if (
        dir === Clutter.ScrollDirection.UP ||
        dir === Clutter.ScrollDirection.LEFT
      ) {
        hadj.adjust_for_scroll_event(-1);
        return Clutter.EVENT_STOP;
      } else if (
        dir === Clutter.ScrollDirection.DOWN ||
        dir === Clutter.ScrollDirection.RIGHT
      ) {
        hadj.adjust_for_scroll_event(1);
        return Clutter.EVENT_STOP;
      }

      return Clutter.EVENT_PROPAGATE;
    });

    this._tabsContainer = new St.BoxLayout({
      style_class: "codexbar-tabs-container",
      orientation: Clutter.Orientation.HORIZONTAL,
    });
    this._tabsScroll.set_child(this._tabsContainer);
    this._indicator.menu.box.add_child(this._tabsScroll);

    this._contentBox = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "codexbar-usage-section",
    });
    this._indicator.menu.box.add_child(this._contentBox);

    // Detail charts are submenus, so they need a real menu section rather than
    // an actor inside the content box. The footer follows the content.
    this._historySection = new PopupMenu.PopupMenuSection();
    this._indicator.menu.addMenuItem(this._historySection);
    this._footerSection = new PopupMenu.PopupMenuSection();
    this._indicator.menu.addMenuItem(this._footerSection);
    this._buildFooter();

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._activeProviderIndex = 0;
    this._providersData = [];
    this._loading = false;
    this._lastRefreshAt = 0;
    this._aboutDialog = null;
    this._cancellable = new Gio.Cancellable();
    this._cost = null;
    this._costLoading = false;
    this._spinnerTimeout = null;
    this._spinnerFrame = 0;

    // Opening the popup is a signal that the user wants current numbers; the
    // timer alone can be up to `refresh-interval` minutes old.
    this._indicator.menu.connect("open-state-changed", (_menu, isOpen) => {
      if (!isOpen) {
        setScrollbarVisible(false);
        return;
      }
      if (this._loading) return;
      if (Date.now() - this._lastRefreshAt < 10000) return;
      this._requestRefresh();
    });

    this._settings.connectObject(
      "changed::providers", () => this._onSettingsChanged(),
      "changed::refresh-interval", () => this._onSettingsChanged(),
      "changed::display-mode", () => this._updateUI(),
      "changed::primary-provider", () => this._updateUI(),
      "changed::show-logos", () => this._updateUI(),
      "changed::show-pacing-info", () => this._updateUI(),
      "changed::show-provider-details", () => {
        this._updateUI();
        if (this._settings.get_boolean("show-provider-details")) this._fetchCost();
      },
      "changed::first-run", () => this._updateUI(),
      "changed::language", () => {
        this._applyLanguage();
        this._updateUI();
        this._requestRefresh();
      },
      "changed::dev-custom-output-enabled", () => this._onSettingsChanged(),
      "changed::dev-custom-output-provider-name", () => this._onSettingsChanged(),
      "changed::dev-custom-output-json", () => this._onSettingsChanged(),
      this
    );
    this._onSettingsChanged();
    this._discoverProviders();

    // Keep the panel's reset countdown ticking between refreshes.
    this._panelTickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._updatePanel();
      return GLib.SOURCE_CONTINUE;
    });
  }

  // Load the catalog for the `language` setting; English is the fallback.
  _applyLanguage() {
    const domain = this.metadata["gettext-domain"] ?? this.uuid;
    applyLanguage(this._settings.get_string("language"), (lang) => {
      const mo = this.dir
        .get_child("locale")
        .get_child(lang)
        .get_child("LC_MESSAGES")
        .get_child(`${domain}.mo`);
      return mo.query_exists(null) ? mo.load_contents(null)[1] : null;
    });
    logDev(`UI language: ${currentLanguage()}`);
  }

  /**
   * Called when the extension is disabled.
   * Se llama cuando la extensión se desactiva.
   */
  disable() {
    if (this._apiClient) {
      this._apiClient.destroy();
      this._apiClient = null;
    }

    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._panelTickId) {
      GLib.source_remove(this._panelTickId);
      this._panelTickId = null;
    }
    if (this._copyTimeouts) {
      this._copyTimeouts.forEach((id) => GLib.source_remove(id));
      this._copyTimeouts = null;
    }
    if (this._spinnerTimeout) {
      GLib.source_remove(this._spinnerTimeout);
      this._spinnerTimeout = null;
    }
    this._refreshSpinner = null;
    this._refreshIcon = null;
    this._refreshBtn = null;

    if (this._aboutDialog) {
      this._aboutDialog.close();
      this._aboutDialog.destroy();
      this._aboutDialog = null;
    }

    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
      setCatalog("en", null); // drop the translation catalog with the extension
    }

    if (this._iconFill) {
      this._iconFill.destroy();
      this._iconFill = null;
    }
    if (this._panelTextBox) {
      this._panelTextBox.destroy();
      this._panelTextBox = null;
    }
    if (this._percentLabel) {
      this._percentLabel.destroy();
      this._percentLabel = null;
    }
    if (this._panelBox) {
      this._panelBox.destroy();
      this._panelBox = null;
    }
    if (this._iconBox) {
      this._iconBox.destroy();
      this._iconBox = null;
    }
    if (this._headerTitle) {
      this._headerTitle.destroy();
      this._headerTitle = null;
    }
    if (this._headerBox) {
      this._headerBox.destroy();
      this._headerBox = null;
    }
    if (this._tabsScroll) {
      this._tabsScroll.destroy();
      this._tabsScroll = null;
    }
    this._tabsContainer = null;
    if (this._contentBox) {
      this._contentBox.destroy();
      this._contentBox = null;
    }
    this._historySection = null;
    this._footerSection = null;
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    if (this._panelTextBox) {
      this._panelTextBox.destroy();
      this._panelTextBox = null;
    }
    if (this._panelBox) {
      this._panelBox.destroy();
      this._panelBox = null;
    }

    this._providersData = [];
    this._activeProviderIndex = 0;
    this._cost = null;
    this._costLoading = false;

    nullTokenSchema();

  }

  /**
   * Add providers that are enabled in the CLI but missing from settings.
   * Runs after enable and merges into the current list, so a concurrent
   * Preferences edit is not overwritten.
   */
  _discoverProviders() {
    if (!this._settings) return;
    let dismissed = [];
    try {
      const value = JSON.parse(
        this._settings.get_string("dismissed-providers"),
      );
      if (Array.isArray(value)) dismissed = value;
    } catch (e) {
      dismissed = [];
    }

    discoverEnabledProviders(
      (discovered) => {
        if (!this._settings) return;

        let saved = [];
        try {
          saved = JSON.parse(this._settings.get_string("providers"));
        } catch (e) {
          saved = [];
        }

        const merged = mergeDiscoveredProviders(
          saved,
          discovered,
          PREDEFINED_PROVIDERS,
          dismissed,
        );
        if (JSON.stringify(merged) !== JSON.stringify(saved)) {
          this._settings.set_string("providers", JSON.stringify(merged));
        }

        // On the first launch there is nothing to ask: the local providers we
        // just enabled are ready to query, so skip the welcome screen instead
        // of waiting for the user to press "Get Started".
        if (
          discovered.length > 0 &&
          merged.length > 0 &&
          this._settings.get_boolean("first-run")
        ) {
          this._settings.set_boolean("first-run", false);
        }
      },
      { skipIds: dismissed },
    );
  }

  _startRefreshSpinner() {
    if (!this._refreshSpinner || !this._refreshIcon) return;
    this._refreshIcon.visible = false;
    this._refreshSpinner.visible = true;
    if (this._spinnerTimeout) return;
    const frames = ["◐", "◓", "◑", "◒"];
    this._spinnerFrame = 0;
    this._spinnerTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      140,
      () => {
        if (!this._refreshSpinner) {
          this._spinnerTimeout = null;
          return GLib.SOURCE_REMOVE;
        }
        this._spinnerFrame = (this._spinnerFrame + 1) % frames.length;
        this._refreshSpinner.set_text(frames[this._spinnerFrame]);
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  _stopRefreshSpinner() {
    if (this._spinnerTimeout) {
      GLib.source_remove(this._spinnerTimeout);
      this._spinnerTimeout = null;
    }
    if (this._refreshIcon) this._refreshIcon.visible = true;
    if (this._refreshSpinner) this._refreshSpinner.visible = false;
  }

  _finishRefresh() {
    this._loading = false;
    this._stopRefreshSpinner();
    if (this._headerTitle) this._headerTitle.set_text(_("CodexBar"));
  }

  /**
   * Handle settings changes.
   */
  _onSettingsChanged() {
    const providersJson = this._settings.get_string("providers");
    try {
      this._providers = JSON.parse(providersJson);
    } catch (e) {
      this._providers = [];
      console.error(e, "CodexBar: Failed to parse providers");
    }

    if (this._activeProviderIndex >= this._providers.length) {
      this._activeProviderIndex = 0;
    }

    // Draw the provider logos right away instead of waiting for the first
    // CLI round-trip, which otherwise leaves the fallback icon up at login.
    this._updatePanel();
    this._requestRefresh();
    this._setupTimeout();
  }

  /**
   * Set up the auto-refresh timer.
   */
  _setupTimeout() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
    }
    const interval = this._settings.get_int("refresh-interval") * 60 * 1000;
    if (interval > 0) {
      this._timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          this._requestRefresh();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }
  }

 

  /**
   * Refresh from UI callbacks without leaving a rejected promise unobserved.
   */
  _requestRefresh() {
    this._refreshData().catch((error) => {
      console.error(error, "CodexBar: refresh failed");
      this._finishRefresh();
    });
  }

  /**
   * Refresh usage data for all enabled providers.
   */
  async _refreshData() {
    if (this._loading || this._providers.length === 0) return;
    this._loading = true;
    this._lastRefreshAt = Date.now();
    this._startRefreshSpinner();

    if (this._headerTitle)
      this._headerTitle.set_text(_("CodexBar (Refreshing...)"));

    logDev("Refreshing usage data...");

    if (this._settings.get_boolean("dev-custom-output-enabled")) {
      const mockName = this._settings.get_string("dev-custom-output-provider-name") || "Mock Provider";
      const mockJson = this._settings.get_string("dev-custom-output-json") || "[]";
      logDev(`[Dev Mode] Simulating custom output for provider: ${mockName}`);
      logDev(`[Dev Mode] Input payload: ${mockJson}`);

      this._providersData = [];
      try {
        const parsed = JSON.parse(mockJson);
        let rawData = Array.isArray(parsed) ? parsed[0] : parsed;
        let finalLabels = [];

        if (rawData) {
          const isAntigravity = mockName.toLowerCase() === "antigravity" || rawData.provider === "antigravity";
          
          if (rawData.usage) {
            logDev(`[Dev Mode] Normalizing nested usage object...`);
            const normalized = this._apiClient.normalizeSummary(
              rawData.usage,
              isAntigravity,
            );
            rawData.usage = normalized.usage;
            finalLabels = normalized.labels || [];
          } else {
            logDev(`[Dev Mode] Normalizing flat usage object...`);
            const normalized = this._apiClient.normalizeSummary(
              rawData,
              isAntigravity,
            );
            rawData = { ...rawData, usage: normalized.usage };
            finalLabels = normalized.labels || [];
          }
        }

        this._providersData[0] = {
          data: rawData,
          labels: finalLabels,
          command: "mock-command",
        };

        this._providers = [{
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        }];
        this._activeProviderIndex = 0;
        logDev(`[Dev Mode] Successfully simulated custom output. Labels: [${finalLabels.join(", ")}]`);
      } catch (error) {
        logDev(`[Dev Mode] Error parsing/normalizing mock output: ${error.message}`);
        this._providersData[0] = {
          error: error.message,
          command: "mock-command",
        };
        this._providers = [{
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        }];
        this._activeProviderIndex = 0;
      }

      this._finishRefresh();
      this._updateUI();
      return;
    }

    // Cost is a separate command and can lag behind usage; fetch it alongside
    // the provider loop and rerender when it arrives.
    if (this._settings.get_boolean("show-provider-details")) this._fetchCost();

    // Keep the last good entry for a provider that fails this round. The popup
    // then shows its previous values with a stale marker instead of going blank
    // because another provider was temporarily unavailable.
    const previousById = new Map();
    (this._providers || []).forEach((provider, index) => {
      const entry = this._providersData?.[index];
      if (provider?.id && entry?.data) previousById.set(provider.id, entry);
    });
    const nextData = new Array(this._providers.length);

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];

      if (provider.useApi) {
        logDev(`Fetching API summary for provider: ${provider.name}`);
        try {
          let data;
          const token = await loadToken(provider.id);
          if (!token) {
            logDev(`Error: No token found in keyring for provider: ${provider.name}`);
            nextData[i] = { error: _("No token found in keyring") };
            continue;
          }
          data = await this._apiClient.fetchSummary(token, provider.id, this._cancellable, {
            workspaceId: provider.workspaceId || "",
          });

          let apiLabels = [];
          if (data.labels && data.labels.length > 0) {
            apiLabels = data.labels;
          } else {
            ["primary", "secondary", "tertiary", "quaternary"].forEach(
              (tier) => {
                const win = data.usage[tier];
                if (win && win.windowSeconds) {
                  const hours = Math.round(win.windowSeconds / 3600);
                  if (hours >= 24) {
                    const days = Math.round(hours / 24);
                    apiLabels.push(
                      days === 7
                        ? _("Weekly Window")
                        : _("%d-Day Window").format(days),
                    );
                  } else {
                    apiLabels.push(_("%d-Hour Window").format(hours));
                  }
                } else if (win) {
                  apiLabels.push(_("Usage Window"));
                }
              },
            );
          }

          nextData[i] = {
            data: data,
            labels: apiLabels,
          };
          logDev(`Successfully fetched API data for provider: ${provider.name}`);
        } catch (error) {
          logDev(`API error for provider ${provider.name}: ${error.message || error}`);
          console.error(error, `CodexBar: API error for ${provider.name}`);
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown API error");
          nextData[i] = { error: msg };
        }
        continue;
      }

      if (!provider.command) {
        logDev(`Error: No CLI command configured for provider: ${provider.name}`);
        nextData[i] = { error: _("No command configured") };
        continue;
      }

      logDev(`Executing CLI command for provider ${provider.name}: ${provider.command}`);
      try {
        const result = await this._apiClient.fetchCliSummary(
          provider.command,
          this._cancellable,
        );
        if (!this._cancellable || this._cancellable.is_cancelled()) {
          logDev(`CLI execution cancelled for provider: ${provider.name}`);
          this._finishRefresh();
          return;
        }

        let rawData = result.data;
        let finalLabels = result.labels || [];

        if (rawData) {
          const isAntigravity =
            provider.id === "antigravity" || rawData.provider === "antigravity";

          if (rawData.usage) {
            const normalized = this._apiClient.normalizeSummary(
              rawData.usage,
              isAntigravity,
            );
            rawData.usage = normalized.usage;
            if (normalized.labels && normalized.labels.length > 0) {
              finalLabels = normalized.labels;
            }
          } else {
            const normalized = this._apiClient.normalizeSummary(
              rawData,
              isAntigravity,
            );
            rawData = { ...rawData, usage: normalized.usage };
            if (normalized.labels && normalized.labels.length > 0) {
              finalLabels = normalized.labels;
            }
          }
        }

        nextData[i] = {
          data: rawData,
          labels: finalLabels,
          command: result.command,
        };
        logDev(`Successfully executed CLI command for provider: ${provider.name}`);
      } catch (error) {
        if (this._cancellable && !this._cancellable.is_cancelled()) {
          logDev(`CLI error for provider ${provider.name}: ${error.message || error}`);
          console.error(
            error,
            `CodexBar: error running provider ${provider.name}`,
          );
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown CLI error");
          nextData[i] = {
            error: msg,
            command: provider.command,
          };
        }
      }
    }

    if (!this._cancellable || this._cancellable.is_cancelled()) {
      this._finishRefresh();
      return;
    }

    // One timestamp for the whole sequential fetch; the panel countdown is
    // skewed by the fetch duration (seconds). Stamp per provider if needed.
    const fetchedAt = Date.now();
    nextData.forEach((entry, index) => {
      if (!entry?.error || entry.data) return;
      const previous = previousById.get(this._providers[index]?.id);
      if (!previous?.data) return;
      nextData[index] = {
        ...previous,
        stale: true,
        staleError: entry.error,
        fetchedAt,
      };
    });
    nextData.forEach((entry) => {
      if (entry) entry.fetchedAt = fetchedAt;
    });

    this._providersData = nextData;
    this._finishRefresh();
    this._updateUI();
  }

  /**
   * Fetch local cost data without blocking the usage refresh. Failures are
   * expected for providers the CLI does not support and simply hide the block.
   */
  async _fetchCost() {
    if (
      this._costLoading ||
      !this._apiClient ||
      !this._cancellable ||
      (this._providers?.length ?? 0) === 0
    )
      return;
    this._costLoading = true;
    try {
      const payload = await this._apiClient.fetchCost(this._cancellable);
      if (!this._cancellable || this._cancellable.is_cancelled()) return;
      const cost = parseCostPayload(payload);
      if (JSON.stringify(cost) === JSON.stringify(this._cost)) return;
      this._cost = cost;
      // While a usage refresh is in flight it will rerender when it finishes;
      // otherwise update an open popup now.
      if (!this._loading && this._indicator?.menu.isOpen) this._updateUI();
    } catch (error) {
      logDev(`Cost fetch failed: ${error.message || error}`);
    } finally {
      this._costLoading = false;
    }
  }

  /**
   * The provider the panel battery tracks.
   */
  _primaryProvider() {
    const providers = this._providers || [];
    if (providers.length === 0) return null;
    const wanted = this._settings?.get_string("primary-provider") || "";
    return providers.find((provider) => provider.id === wanted) || providers[0];
  }

  /**
   * Average usage percentage for a provider entry, honouring display mode.
   * @param {object|undefined} entry
   * @returns {number}
   */
  _usagePercent(entry) {
    const usage = entry?.data?.usage;
    if (!usage) return 0;
    const displayMode = this._settings.get_string("display-mode");
    const creditsPercent = deriveCreditsPercent(
      normalizeDetailSections(usage.details),
    );
    const degenerate = (tierData) =>
      !!tierData &&
      !tierData.windowSeconds &&
      tierData.usedPercent === 0 &&
      !tierData.resetDescription;

    let total = 0;
    let count = 0;
    for (const tier of ["primary", "secondary", "tertiary", "quaternary"]) {
      const tierData = usage[tier];
      if (!tierData || tierData.usedPercent === undefined) continue;
      if (degenerate(tierData) && creditsPercent === null) continue;
      const percent = degenerate(tierData)
        ? creditsPercent
        : this._normalizePercent(tierData.usedPercent);
      total += displayMode === "remaining" ? 100 - percent : percent;
      count++;
    }
    if (count === 0 && usage.providerCost && usage.providerCost.limit > 0) {
      const percent = (usage.providerCost.used / usage.providerCost.limit) * 100;
      total += displayMode === "remaining" ? 100 - percent : percent;
      count++;
    }
    return count > 0 ? total / count : 0;
  }

  /**
   * Theme colour for a usage percentage.
   */
  _usageColor(percent) {
    const displayMode = this._settings.get_string("display-mode");
    if (displayMode === "remaining") {
      if (percent < 10) return "#e01b24";
      if (percent < 25) return "#ff7800";
      if (percent < 50) return "#f6d32d";
    } else {
      if (percent > 90) return "#e01b24";
      if (percent > 75) return "#ff7800";
      if (percent > 50) return "#f6d32d";
    }
    return "#3584e4";
  }

  /**
   * Render the panel text for providers flagged showInPanel, or fall back to
   * the usage bar when none are.
   */
  _updatePanel() {
    if (!this._panelTextBox) return;

    const shown = (this._providers || [])
      .map((provider, index) => ({ provider, entry: this._providersData[index] }))
      .filter(({ provider }) => provider.showInPanel);

    this._iconBox.visible = shown.length === 0;
    this._panelTextBox.visible = shown.length > 0;
    this._panelTextBox.destroy_all_children();
    if (this._percentLabel) {
      this._percentLabel.visible = shown.length === 0;
      this._percentLabel.set_text(
        `${formatPercent(Math.round(this._activePercent ?? 0))}%`,
      );
    }
    logDev(
      shown.length === 0
        ? `Panel: battery at ${this._percentLabel?.text}`
        : `Panel: ${shown.length} provider text segment(s)`,
    );

    const displayMode = this._settings.get_string("display-mode");
    shown.forEach(({ provider, entry }) => {
      const segment = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: "codexbar-panel-segment",
      });
      const logo = this._getProviderLogo(
        provider.id || provider.name.toLowerCase(),
      );
      if (logo) {
        logo.set_style_class_name("codexbar-panel-logo");
        segment.add_child(logo);
      }

      let text;
      if (!entry) text = "…";
      else if (entry.error && !entry.data) text = "!";
      else {
        const elapsed = (Date.now() - (entry.fetchedAt || Date.now())) / 1000;
        text = formatPanelText(entry.data?.usage, displayMode, elapsed, _) || "–";
      }
      if (!logo) text = `${provider.name} ${text}`;

      segment.add_child(
        new St.Label({ text, y_align: Clutter.ActorAlign.CENTER }),
      );
      this._panelTextBox.add_child(segment);
    });
  }

  /**
   * Footer links for the active provider and the project.
   */
  _buildFooter() {
    if (!this._footerSection) return;

    const open = (uri) => () => {
      try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
      } catch (e) {
        console.error(`[CodexBar] could not open ${uri}: ${e}`);
      }
      this._indicator?.menu.close();
    };
    const add = (label, iconName, onActivate) => {
      const item = new PopupMenu.PopupMenuItem(label);
      if (iconName) {
        item.add_child(
          new St.Icon({
            icon_name: iconName,
            style_class: "popup-menu-icon",
          }),
        );
      }
      item.connect("activate", onActivate);
      this._footerSection.addMenuItem(item);
    };
    const providerId = () =>
      this._providers?.[this._activeProviderIndex]?.id || "";

    add(_("Add Provider..."), "list-add-symbolic", () => {
      this._indicator?.menu.close();
      this.openPreferences();
    });
    add(_("Usage Dashboard"), "view-list-symbolic", () =>
      open(usageUrl(providerId()))(),
    );
    add(_("Status Page"), "network-transmit-receive-symbolic", () =>
      open(statusUrl(providerId()))(),
    );
    add(_("Refresh Now"), "view-refresh-symbolic", () => {
      this._indicator?.menu.close();
      this._requestRefresh();
    });

    this._footerSection.addMenuItem(
      new PopupMenu.PopupSeparatorMenuItem(),
    );
    add(_("About CodexBar"), "help-about-symbolic", () => {
      this._indicator?.menu.close();
      this._showAbout();
    });
  }

  /**
   * About dialog with project and licence links.
   */
  _showAbout() {
    if (this._aboutDialog) return;

    const name = this.metadata?.name || "CodexBar";
    const version =
      this.metadata?.["version-name"] || this.metadata?.version || "";
    const dialog = new ModalDialog({
      shellReactive: true,
      shouldFadeIn: false,
      shouldFadeOut: false,
    });

    const text = new St.Label({
      text:
        `${name}${version ? ` — ${_("Version")} ${version}` : ""}\n\n` +
        _(
          "AI provider usage in the GNOME panel.\nBased on CodexBar by @steipete. MIT-INLED licence.",
        ),
    });
    text.clutter_text.line_wrap = true;
    dialog.contentLayout.add_child(text);

    for (const [label, url] of [
      [_("This extension"), EXTENSION_REPO_URL],
      [_("codexbar CLI"), CLI_REPO_URL],
      [_("Upstream on extensions.gnome.org"), EGO_URL],
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

    dialog.setButtons([
      {
        label: _("Close"),
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
      },
    ]);
    this._aboutDialog = dialog;
    dialog.connect("destroy", () => {
      if (this._aboutDialog === dialog) this._aboutDialog = null;
    });
    if (!dialog.open()) {
      this._aboutDialog = null;
      dialog.destroy();
    }
  }

  /**
   * Normalize percentage value.
   * Normalize a percentage value.
   */
  _normalizePercent(value) {
    if (value === undefined || value === null) return 0;
    let p = parseFloat(value);
    return Math.min(100, Math.max(0, p));
  }

  /**
   * Check if a binary exists in the PATH or standard directories.
   * Comprueba si existe un binario en el PATH o en directorios estándar.
   */
  _checkBinaryExists(name) {
    if (GLib.find_program_in_path(name)) {
      return true;
    }
    const commonPaths = [
      `/home/linuxbrew/.linuxbrew/bin/${name}`,
      `${GLib.get_home_dir()}/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];
    for (const path of commonPaths) {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update the indicator menu UI.
   */
  _updateUI() {
    if (!this._indicator) return;

    this._updatePanel();
    this._tabsContainer.destroy_all_children();
    this._contentBox.destroy_all_children();
    this._historySection?.removeAll();

    const displayMode = this._settings.get_string("display-mode");
    const firstRun = this._settings.get_boolean("first-run");

    const codexbarExists = this._checkBinaryExists("codexbar");
    const importerExists = this._checkBinaryExists("codexbar-cookie-importer");

    if (firstRun || !codexbarExists) {
      this._showWelcomeScreen(codexbarExists, importerExists);
      return;
    }

    const activeData = this._providersData[this._activeProviderIndex];
    // A tier with usedPercent:0 and no windowSeconds isn't a real usage window
    // (e.g. OpenRouter's balance placeholder), so _usagePercent() derives a
    // meaningful percent from Credits instead.
    const isDegenerateTier = (tierData) =>
      !!tierData &&
      !tierData.windowSeconds &&
      tierData.usedPercent === 0 &&
      !tierData.resetDescription;
    const creditsPercent = deriveCreditsPercent(
      normalizeDetailSections(activeData?.data?.usage?.details),
    );

    // The panel tracks one provider, not whichever tab happens to be open.
    const primaryProvider = this._primaryProvider();
    const primaryIndex = primaryProvider
      ? this._providers.indexOf(primaryProvider)
      : -1;
    const panelPercent =
      primaryIndex >= 0 ? this._usagePercent(this._providersData[primaryIndex]) : 0;
    this._activePercent = panelPercent;

    const showLogos = this._settings.get_boolean("show-logos");

    this._providers.forEach((provider, index) => {
      const percent = this._usagePercent(this._providersData[index]);
      const hasData = !!this._providersData[index]?.data;
      const entryFailed = !!this._providersData[index]?.error;

      let btn = new St.Button({
        style_class: "codexbar-tab",
        can_focus: true,
        accessible_name: provider.name || _("Unknown"),
      });

      const column = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
      });
      const top = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      });

      if (showLogos) {
        const logoIcon = this._getProviderLogo(provider.id, provider.name);
        if (logoIcon) top.add_child(logoIcon);
      }

      top.add_child(
        new St.Label({
          text: provider.name || _("Unknown"),
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );
      column.add_child(top);

      // Each tab carries its own load, so a provider nearing its limit is
      // visible without switching to it.
      const track = new St.BoxLayout({ style_class: "codexbar-tab-track" });
      if (hasData && !entryFailed) {
        track.add_child(
          new St.Widget({
            style_class: "codexbar-tab-fill",
            style: `width: ${Math.max(1, Math.round((TAB_TRACK_WIDTH * percent) / 100))}px; background-color: ${this._usageColor(percent)};`,
          }),
        );
      }
      column.add_child(track);
      btn.set_child(column);

      if (index === this._activeProviderIndex) {
        btn.add_style_class_name("codexbar-tab-active");
      }
      btn.connect("clicked", () => {
        this._activeProviderIndex = index;
        this._updateUI();
      });
      this._tabsContainer.add_child(btn);

      if (
        provider.id === primaryProvider?.id &&
        this._providers.length > 1
      ) {
        this._tabsContainer.add_child(
          new St.Widget({
            style_class: "codexbar-tab-primary-dot",
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
      }
    });

    if (this._iconFill) {
      // Interior width of the box (15px - 2*1px border - 2*1px padding = 11px)
      const totalFillWidth = 11;
      const fillWidth = Math.max(
        1,
        Math.min(
          totalFillWidth,
          Math.round((panelPercent / 100) * totalFillWidth),
        ),
      );
      this._iconFill.set_width(fillWidth);
      this._iconFill.set_style(
        `background-color: ${this._usageColor(panelPercent)};`,
      );
    }

    if (this._providers.length === 0) {
      this._contentBox.add_child(
        new St.Label({ text: _("No providers configured. Click settings.") }),
      );
      return;
    }

    const activeProvider = this._providers[this._activeProviderIndex];
    // Reuse activeData already declared above

    if (!activeData) {
      this._contentBox.add_child(new St.Label({ text: _("Loading data...") }));
      return;
    }

    if (activeData.error && !activeData.data) {
      let errorBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });

      let title = new St.Label({
        text: _("Error: %s").format(activeData.error),
        style: "color: #ff7800; font-weight: bold; margin-bottom: 10px;",
      });
      errorBox.add_child(title);

      if (activeData.stderr) {
        errorBox.add_child(
          new St.Label({
            text: _("Stderr:"),
            style: "font-weight: bold; font-size: 0.8em; margin-top: 5px;",
          }),
        );
        let scroll = new St.ScrollView({
          hscrollbar_policy: St.PolicyType.AUTOMATIC,
          vscrollbar_policy: St.PolicyType.NEVER,
          style:
            "background-color: rgba(0,0,0,0.2); border-radius: 4px; padding: 5px;",
        });
        scroll.add_child(
          new St.Label({
            text: activeData.stderr,
            style: "font-family: monospace; font-size: 0.8em;",
          }),
        );
        errorBox.add_child(scroll);
      }

      this._contentBox.add_child(errorBox);
      return;
    }

    const data = activeData.data;
    if (!data || !data.usage) {
      this._contentBox.add_child(
        new St.Label({ text: _("Invalid JSON format (missing usage)") }),
      );
      return;
    }

    const usage = data.usage;
    const showPacing = this._settings.get_boolean("show-pacing-info");

    if (usage.accountEmail) {
      let accountBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        margin_bottom: 15,
      });
      accountBox.add_child(
        new St.Label({
          text: activeProvider.name,
          style_class: "codexbar-usage-title",
          style: "font-size: 1.1em;",
        }),
      );
      let accText = usage.accountEmail;
      if (usage.loginMethod) accText += ` (${usage.loginMethod})`;
      const accountDetails = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
      });
      accountDetails.add_child(subtitleLabel({ text: accText }));
      if (usage.planType) {
        const planText =
          usage.planType.charAt(0).toUpperCase() + usage.planType.slice(1);
        accountDetails.add_child(
          subtitleLabel({
            text: planText,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
          }),
        );
      }
      accountBox.add_child(accountDetails);

      if (usage.updatedAt) {
        let date = new Date(usage.updatedAt);
        let dateStr = date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        accountBox.add_child(
          subtitleLabel({ text: _("Updated %s").format(dateStr) }),
        );
      }
      this._contentBox.add_child(accountBox);
    }

    if (activeData.stale) {
      this._contentBox.add_child(
        subtitleLabel({ text: _("Showing last known values") }),
      );
      if (activeData.staleError) {
        const staleNote = subtitleLabel({ text: activeData.staleError });
        staleNote.clutter_text.line_wrap = true;
        this._contentBox.add_child(staleNote);
      }
    }

    this._renderDetailSections(usage);
    this._renderCost(activeProvider.id);

    const tiers = ["primary", "secondary", "tertiary", "quaternary"];
    const discoveredLabels = activeData.labels || [];
    let hasTiers = false;

    const usageEntries = tiers.map((tier, tierIdx) => {
      let tierData = usage[tier];
      let title = localizeLabel(
        discoveredLabels[tierIdx] ||
        tier.charAt(0).toUpperCase() + tier.slice(1),
        _,
      );

      if (isDegenerateTier(tierData)) {
        if (creditsPercent === null) {
          tierData = null;
        } else {
          tierData = { ...tierData, usedPercent: creditsPercent };
          title = _("Credits");
        }
      } else if (tierData && !tierData.windowSeconds && tierData.resetDescription) {
        title = discoveredLabels[tierIdx] || _("Balance");
      }

      return { data: tierData, showPace: true, title };
    });
    usageEntries.push({
      data: usage.codeReview,
      showPace: false,
      title: _("Code review"),
    });

    usageEntries.forEach((entry) => {
      if (entry.data && entry.data.usedPercent !== undefined) {
        hasTiers = true;
        let tierData = entry.data;

        this._contentBox.add_child(
          new St.Label({
            text: entry.title,
            style_class: "codexbar-usage-title",
          }),
        );

        const fullWidth = 290;
        let p = this._normalizePercent(tierData.usedPercent);
        const pace = calculateUsagePace(tierData);

        let percent = displayMode === "remaining" ? 100 - p : p;
        let labelText =
          displayMode === "remaining"
            ? _("%s%% left").format(formatPercent(percent))
            : _("%s%% used").format(formatPercent(percent));

        let color = "#3584e4";
        if (displayMode === "remaining") {
          if (percent < 10) color = "#e01b24";
          else if (percent < 25) color = "#ff7800";
          else if (percent < 50) color = "#f6d32d";
        } else {
          if (percent > 90) color = "#e01b24";
          else if (percent > 75) color = "#ff7800";
          else if (percent > 50) color = "#f6d32d";
        }

        const barWidth = Math.max(1, Math.round((percent / 100) * fullWidth));

        // A plain St.Widget track (not a BoxLayout) lets the fill and the pace
        // tick overlap at explicit x positions instead of sitting side by side.
        let progressContainer = new St.Widget({
          style_class: "codexbar-progress-container",
          width: fullWidth,
          height: 6,
        });
        let progressBar = new St.Widget({
          style_class: "codexbar-progress-bar",
          x: 0,
          width: barWidth,
          style: `width: ${barWidth}px; background-color: ${color};`,
        });
        progressContainer.add_child(progressBar);

        if (showPacing && entry.showPace && pace) {
          const expected = Math.max(
            0,
            Math.min(100, pace.expectedUsedPercent),
          );
          const expectedDisplay =
            displayMode === "remaining" ? 100 - expected : expected;
          const markerX = Math.max(
            0,
            Math.min(
              fullWidth - 2,
              Math.round((expectedDisplay / 100) * fullWidth) - 1,
            ),
          );
          progressContainer.add_child(
            new St.Widget({
              style_class: "codexbar-pace-marker",
              x: markerX,
              y: -2,
              width: 2,
              height: 10,
            }),
          );
        }

        this._contentBox.add_child(progressContainer);

        const statsBox = new St.BoxLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          x_expand: true,
        });
        statsBox.add_child(
          subtitleLabel({
            text: labelText,
            x_align: Clutter.ActorAlign.START,
          }),
        );
        statsBox.add_child(
          subtitleLabel({
            text:
              (tierData.resetAfterSeconds
                ? formatReset(
                    tierData.resetAfterSeconds,
                    (Date.now() - (activeData.fetchedAt || Date.now())) / 1000,
                    _,
                  )
                : tierData.resetDescription) || "",
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
          }),
        );

        this._contentBox.add_child(statsBox);

        if (showPacing && entry.showPace && tierData.windowSeconds >= 7 * 24 * 3600 && pace) {
          const roundedReserve = Math.round(pace.reservePercent);
          const paceBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
          });
          paceBox.add_child(
            subtitleLabel({
              text:
                roundedReserve >= 0
                  ? _("%d%% in reserve").format(roundedReserve)
                  : _("%d%% over pace").format(Math.abs(roundedReserve)),
            }),
          );
          paceBox.add_child(
            subtitleLabel({
              text:
                roundedReserve >= 0
                  ? _("Lasts until reset")
                  : _("May run out before reset"),
              x_align: Clutter.ActorAlign.END,
              x_expand: true,
            }),
          );
          this._contentBox.add_child(paceBox);
        }

        let sep = new St.Widget({
          style:
            "height: 1px; background-color: rgba(127,127,127,0.22); margin-bottom: 10px; margin-top: 5px;",
        });
        this._contentBox.add_child(sep);
      }
    });

    if (usage.rateLimitResetCredits?.availableCount !== undefined) {
      const creditCount = usage.rateLimitResetCredits.availableCount;
      const creditsBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "codexbar-reset-credits",
        x_expand: true,
      });
      creditsBox.add_child(
        new St.Label({
          text: _("Limit reset credits"),
          style_class: "codexbar-usage-title",
        }),
      );
      creditsBox.add_child(
        subtitleLabel({
          text:
            creditCount === 1
              ? _("1 available")
              : _("%d available").format(creditCount),
        }),
      );
      this._contentBox.add_child(creditsBox);
    }

    if (Number.isFinite(usage.balanceUSD)) {
      const balanceBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "codexbar-cost-container",
        x_expand: true,
      });
      balanceBox.add_child(new St.Label({
        text: _("Zen balance"),
        style_class: "codexbar-cost-title",
      }));
      balanceBox.add_child(new St.Label({
        text: new Intl.NumberFormat(undefined, {style: "currency", currency: "USD"}).format(usage.balanceUSD),
        style_class: "codexbar-cost-value",
      }));
      this._contentBox.add_child(balanceBox);
    }
    if (usage.subscriptionStatus === "none" && !usage.providerCost) {
      this._contentBox.add_child(new St.Label({
        text: _("No active OpenCode Go subscription in this workspace."),
        style_class: "codexbar-detail-note",
      }));
    }

    if (!hasTiers && usage.providerCost) {
      let costBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "codexbar-cost-container",
        x_expand: true,
      });

      let costTitleStr = usage.providerCost.period || _("Balance");
      let costTitle = new St.Label({
        text: costTitleStr,
        style_class: "codexbar-cost-title",
        x_align: Clutter.ActorAlign.CENTER,
      });
      costTitle.opacity = SECONDARY_TEXT_OPACITY;
      costBox.add_child(costTitle);

      let formattedAmount = "";
      try {
        let currency = usage.providerCost.currencyCode || "USD";
        let used = usage.providerCost.used || 0;
        let limit = usage.providerCost.limit || 0;
        let formatter = new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: currency,
        });
        if (limit > 0) {
          formattedAmount = `${formatter.format(used)} / ${formatter.format(limit)}`;
        } else {
          formattedAmount = formatter.format(used);
        }
      } catch (e) {
        let currencySymbol = usage.providerCost.currencyCode === "USD" ? "$" : (usage.providerCost.currencyCode || "");
        let used = usage.providerCost.used || 0;
        let limit = usage.providerCost.limit || 0;
        if (limit > 0) {
          formattedAmount = `${currencySymbol}${used.toFixed(2)} / ${currencySymbol}${limit.toFixed(2)}`;
        } else {
          formattedAmount = `${currencySymbol}${used.toFixed(2)}`;
        }
      }

      let costValue = new St.Label({
        text: formattedAmount,
        style_class: "codexbar-cost-value",
        x_align: Clutter.ActorAlign.CENTER,
      });
      costBox.add_child(costValue);

      this._contentBox.add_child(costBox);
    }
  }

  /**
   * Local spend/token estimate from `codexbar cost`, when the CLI reports it.
   * @param {string} providerId
   */
  _renderCost(providerId) {
    if (!this._settings.get_boolean("show-provider-details")) return;
    const cost = this._cost?.providers?.find((entry) => entry.id === providerId);
    if (!cost) return;

    const hasValues = [
      cost.todayCost,
      cost.todayTokens,
      cost.periodCost,
      cost.periodTokens,
      cost.cost,
      cost.tokens,
    ].some((value) => value > 0);
    if (!hasValues) return;

    const box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "codexbar-cost-container",
      x_expand: true,
    });
    box.add_child(
      new St.Label({
        text: _("Local cost estimate"),
        style_class: "codexbar-cost-title",
        x_align: Clutter.ActorAlign.CENTER,
      }),
    );

    const line = (label, money, tokens) => {
      const parts = [];
      if (money > 0) parts.push(formatMoney(money, cost.currency));
      if (tokens > 0)
        parts.push(_("%s tokens").format(formatTokens(tokens)));
      if (parts.length === 0) return;
      const row = new St.BoxLayout({ x_expand: true });
      const text = new St.Label({
        text: `${label}: ${parts.join(" · ")}`,
        style_class: "codexbar-detail-note",
        x_expand: true,
      });
      text.opacity = SECONDARY_TEXT_OPACITY;
      row.add_child(text);
      box.add_child(row);
    };

    line(_("Today"), cost.todayCost, cost.todayTokens);
    if (cost.periodCost > 0 || cost.periodTokens > 0)
      line(cost.periodLabel || _("Last 30 days"), cost.periodCost, cost.periodTokens);
    if (cost.cost > 0 || cost.tokens > 0)
      line(_("All time"), cost.cost, cost.tokens);

    this._contentBox.add_child(box);
  }

  /**
   * Render provider-supplied detail sections (codexbar `usage.details`).
   * @param {object} usage
   */
  _renderDetailSections(usage) {
    if (!this._settings.get_boolean("show-provider-details")) return;

    const sections = normalizeDetailSections(usage?.details);
    if (sections.length === 0) return;

    const detailsBox = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style_class: "codexbar-details-section",
      x_expand: true,
    });
    let hasRows = false;

    sections.forEach((section) => {
      const groupBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "codexbar-detail-group",
        x_expand: true,
      });

      if (section.title) {
        groupBox.add_child(
          new St.Label({
            text: localizeDetail(section.title, _),
            style_class: "codexbar-detail-title",
          }),
        );
      }

      section.rows.forEach((row) => {
        const rowBox = new St.BoxLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          x_expand: true,
        });

        const labelWidget = new St.Label({
          text: localizeDetail(row.label, _),
          style_class: "codexbar-detail-label",
        });
        labelWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labelWidget.opacity = 200;
        rowBox.add_child(labelWidget);

        const valueWidget = new St.Label({
          text: localizeDetail(row.value, _),
          style_class: "codexbar-detail-value",
          x_align: Clutter.ActorAlign.END,
          x_expand: true,
        });
        valueWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        rowBox.add_child(valueWidget);

        groupBox.add_child(rowBox);

        if (row.secondaryValue) {
          const noteWidget = new St.Label({
            text: localizeDetail(row.secondaryValue, _),
            style_class: "codexbar-detail-note",
          });
          noteWidget.clutter_text.line_wrap = true;
          noteWidget.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
          noteWidget.opacity = 160;
          groupBox.add_child(noteWidget);
        }
      });

      if (section.rows.length) {
        hasRows = true;
        detailsBox.add_child(groupBox);
      }

      if (section.chart) {
        const item = new PopupMenu.PopupSubMenuMenuItem(
          localizeDetail(
            section.chart.title || section.title || _("Chart"),
            _,
          ),
        );
        this._addChartToMenu(
          item.menu,
          section.chart.points,
          section.chart.unit,
        );
        this._historySection?.addMenuItem(item);
      }
    });

    if (hasRows) this._contentBox.add_child(detailsBox);
  }

  /**
   * Draw a small bar chart inside a submenu. Each bar is focusable and reports
   * its label and value, which keeps the chart usable without a pointer.
   * @param {object} menu PopupMenu section
   * @param {Array<{label: string, value: number}>} points
   * @param {string} unit Optional chart unit, e.g. USD or %
   */
  _addChartToMenu(menu, points, unit = "") {
    if (!Array.isArray(points) || points.length === 0) return;

    const format = (value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) return "";
      if (unit === "USD") return `$${number.toFixed(2)}`;
      if (unit === "%") return `${number.toFixed(1)}%`;
      return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
    };

    const detail = subtitleLabel({
      text: _("Hover or focus a bar for details"),
    });
    menu.box.add_child(detail);

    const maximum = Math.max(
      0,
      ...points.map((point) => Math.max(0, Number(point.value) || 0)),
    );
    const row = new St.BoxLayout({
      style_class: "codexbar-chart-row",
      x_expand: true,
    });
    if (row.layout_manager) row.layout_manager.homogeneous = true;

    points.forEach((point) => {
      const description = `${point.label}: ${format(point.value)}`;
      const button = new St.Button({
        can_focus: true,
        x_expand: true,
        style_class: "codexbar-chart-day",
        accessible_name: description,
      });
      const height = maximum
        ? Math.max(
            2,
            Math.round(
              (48 * Math.max(0, Number(point.value) || 0)) / maximum,
            ),
          )
        : 2;
      button.set_child(
        new St.Widget({
          style_class: "codexbar-chart-bar",
          x_expand: true,
          x_align: Clutter.ActorAlign.FILL,
          height,
          y_align: Clutter.ActorAlign.END,
        }),
      );
      const show = () => {
        detail.text = description;
      };
      button.connect("clicked", show);
      button.connect("enter-event", show);
      button.connect("key-focus-in", show);
      row.add_child(button);
    });
    menu.box.add_child(row);
  }

  /**
   * Get provider logo as an St.Icon.
   * Obtener el logo del proveedor como un St.Icon.
   * @param {string} providerId
   * @returns {St.Icon|null}
   */
  _getProviderLogo(providerId, providerName = "") {
    if (!providerId && !providerName) return null;

    // Normalize ID and name: lowercase and replace spaces with dashes
    const candidates = [
      (providerId || "").toLowerCase().replace(/\s+/g, "-"),
      (providerName || "").toLowerCase().replace(/\s+/g, "-"),
    ].filter((c) => c.length > 0);

    // Known provider keys for fallback matching of custom or renamed providers
    // (e.g. a custom "Codex CLI" provider still shows the Codex logo).
    const knownKeys = [
      "opencodego",
      "opencode",
      "codex",
      "claude",
      "gemini",
      "deepseek",
      "copilot",
      "openrouter",
      "perplexity",
      "mistral",
      "antigravity",
      "ollama",
    ];

    const tried = new Set();
    const logoFor = (key) => {
      if (!key || tried.has(key)) return null;
      tried.add(key);
      const logoPath = GLib.build_filenamev([
        this.path,
        "media",
        "logos",
        `${key}-symbolic.svg`,
      ]);

      if (GLib.file_test(logoPath, GLib.FileTest.EXISTS)) {
        const gicon = Gio.Icon.new_for_string(logoPath);

        return new St.Icon({
          gicon: gicon,
          icon_size: 16,
          style_class: "codexbar-tab-icon",
        });
      }
      return null;
    };

    for (const candidate of candidates) {
      const icon = logoFor(candidate);
      if (icon) return icon;
    }

    for (const candidate of candidates) {
      for (const key of knownKeys) {
        if (candidate.includes(key)) {
          const icon = logoFor(key);
          if (icon) return icon;
        }
      }
    }

    return null;
  }

  /**
   * Helper to create a command box with a Copy button.
   * Crea un contenedor con el comando y un botón para copiar al portapapeles.
   */
  _createCommandWithCopyButton(commandText) {
    let box = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      x_expand: true,
      style:
        "background-color: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px; margin-top: 4px; spacing: 8px;",
    });

    let cmdLabel = new St.Label({
      text: commandText,
      style:
        "font-family: monospace; font-size: 0.8em; color: #3584e4; y-align: middle;",
      x_expand: true,
    });
    cmdLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(cmdLabel);

    let copyBtn = new St.Button({
      style:
        "padding: 2px 6px; background-color: rgba(127,127,127,0.18); border-radius: 3px; font-size: 0.8em;",
      label: _("Copy"),
    });
    copyBtn.connect("clicked", () => {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, commandText);
      copyBtn.label = _("Copied!");
      let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        copyBtn.label = _("Copy");
        if (this._copyTimeouts) {
          const index = this._copyTimeouts.indexOf(timeoutId);
          if (index > -1) {
            this._copyTimeouts.splice(index, 1);
          }
        }
        return GLib.SOURCE_REMOVE;
      });
      if (this._copyTimeouts) {
        this._copyTimeouts.push(timeoutId);
      }
    });
    box.add_child(copyBtn);

    return box;
  }

  /**
   * Show welcome screen for first-run or missing dependencies.
   * Muestra la pantalla de bienvenida para la primera ejecución o dependencias faltantes.
   */
  _showWelcomeScreen(codexbarExists, importerExists) {
    let box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      spacing: 10,
      style: "padding: 12px;",
    });

    box.add_child(
      new St.Label({
        text: _("Welcome to CodexBar!"),
        style: "font-weight: bold; font-size: 1.25em; margin-bottom: 5px;",
      }),
    );

    // Language names stay in their own language; not passed to gettext.
    const langRow = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      spacing: 6,
      style: "margin-bottom: 8px;",
      x_align: Clutter.ActorAlign.START,
    });
    langRow.add_child(
      new St.Label({
        text: _("Language:"),
        style: "font-size: 0.95em; margin-top: 4px;",
      }),
    );
    const currentLang = this._settings.get_string("language");
    [
      ["en", "English"],
      ["es", "Español"],
      ["pt_BR", "Português (Brasil)"],
    ].forEach(([code, name]) => {
      const langBtn = new St.Button({
        label: name,
        style_class: "codexbar-tab",
        style:
          code === currentLang
            ? "background-color: #3584e4;"
            : "background-color: rgba(127,127,127,0.15);",
      });
      langBtn.connect("clicked", () =>
        this._settings.set_string("language", code),
      );
      langRow.add_child(langBtn);
    });
    box.add_child(langRow);

    box.add_child(
      new St.Label({
        text: _("Please configure your system dependencies:"),
        style: "font-size: 0.95em; color: #2ec27e; margin-bottom: 10px;",
      }),
    );

    let dep1Box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style:
        "margin-bottom: 10px; background-color: rgba(127,127,127,0.10); padding: 8px; border-radius: 6px;",
    });
    let dep1Header = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
    });

    let dep1StatusColor = codexbarExists ? "#2ec27e" : "#e01b24";
    let dep1StatusText = codexbarExists ? _("● Installed") : _("● Missing");

    dep1Header.add_child(
      new St.Label({
        text: _("1. CodexBar CLI  "),
        style: "font-weight: bold;",
      }),
    );
    dep1Header.add_child(
      new St.Label({
        text: dep1StatusText,
        style: `color: ${dep1StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep1Box.add_child(dep1Header);

    dep1Box.add_child(
      subtitleLabel({
        text: _("Required to query AI usage metrics."),
        style:
          "font-size: 0.85em; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!codexbarExists) {
      dep1Box.add_child(
        this._createCommandWithCopyButton("brew install steipete/tap/codexbar"),
      );
    }
    box.add_child(dep1Box);

    let dep2Box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style:
        "margin-bottom: 10px; background-color: rgba(127,127,127,0.10); padding: 8px; border-radius: 6px;",
    });
    let dep2Header = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
    });

    let dep2StatusColor = importerExists ? "#2ec27e" : "#ff7800";
    let dep2StatusText = importerExists
      ? _("● Installed")
      : _("● Optional (only for codex users and only if you want not to find and copy manually a cookie value)");

    dep2Header.add_child(
      new St.Label({
        text: _("2. Cookie Importer  "),
        style: "font-weight: bold;",
      }),
    );
    dep2Header.add_child(
      new St.Label({
        text: dep2StatusText,
        style: `color: ${dep2StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep2Box.add_child(dep2Header);

    dep2Box.add_child(
      subtitleLabel({
        text: _("Enables browser auto cookie extraction for Codex (ChatGPT). This cookie is used to authenticate on the usage api of OpenAI"),
        style:
          "font-size: 0.85em; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!importerExists) {
      dep2Box.add_child(
        this._createCommandWithCopyButton(
          "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer",
        ),
      );
    }
    box.add_child(dep2Box);

    let dep3Box = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      style:
        "margin-bottom: 10px; background-color: rgba(127,127,127,0.10); padding: 8px; border-radius: 6px;",
    });
    let dep3Header = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
    });

    // Verify if the certificate is already installed/trusted
    const systemCaCertsPath = "/usr/local/share/ca-certificates/antigravity.crt";
    const certInstalled = GLib.file_test(systemCaCertsPath, GLib.FileTest.EXISTS);
    let dep3StatusColor = certInstalled ? "#2ec27e" : "#ff7800";
    let dep3StatusText = certInstalled
      ? _("● Installed")
      : _("● Optional (for Antigravity)");

    dep3Header.add_child(
      new St.Label({
        text: _("3. AGY Server Certificate Trust Helper  "),
        style: "font-weight: bold;",
      }),
    );
    dep3Header.add_child(
      new St.Label({
        text: dep3StatusText,
        style: `color: ${dep3StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep3Box.add_child(dep3Header);

    dep3Box.add_child(
      subtitleLabel({
        text: _("Required to trust the local Antigravity server certificate. Requires privilegie elevation"),
        style:
          "font-size: 0.85em; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!certInstalled) {
      dep3Box.add_child(
        this._createCommandWithCopyButton(
          "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper",
        ),
      );
    }
    box.add_child(dep3Box);

    let btnBox = new St.BoxLayout({
      orientation: Clutter.Orientation.HORIZONTAL,
      style: "margin-top: 10px;",
      x_align: Clutter.ActorAlign.CENTER,
    });

    let closeBtn = new St.Button({
      label: _("Get Started!"),
      style_class: "codexbar-tab",
      style: "background-color: #3584e4;",
    });
    closeBtn.connect("clicked", () => {
      this._settings.set_boolean("first-run", false);
      this._requestRefresh();
    });
    btnBox.add_child(closeBtn);
    box.add_child(btnBox);

    this._contentBox.add_child(box);
  }
}
