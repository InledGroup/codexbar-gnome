// This file contains the main skeleton of the extension. Is like the HTML ;)

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { calculateUsagePace, UsageApiClient } from "./usageApi.js";
import { loadToken, nullTokenSchema } from "./secret.js";

function logDev(msg) {
  console.log(`[CodexBar] ${msg}`);
}

/**
 * Main extension class for CodexBar.
 * Clase principal de la extensión para CodexBar.
 */
export default class CodexBarExtension extends Extension {
  /**
   * Called when the extension is enabled.
   * Se llama cuando la extensión se activa.
   */
  enable() {
    // Obtiene los ajustes
    this._settings = this.getSettings();
    this._apiClient = new UsageApiClient(this.path);
    this._copyTimeouts = [];

    // Main indicator button in the panel
    // El botón principal (el del uso)
    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);

    // Icon container with progress fill
    // Contenedor del icono con relleno de progreso
    this._iconBox = new St.BoxLayout({
      style_class: "codexbar-panel-icon-box",
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._iconFill = new St.Widget({
      style_class: "codexbar-panel-icon-fill",
      x_expand: false,
      width: 0,
    });
    this._iconBox.add_child(this._iconFill);
    this._indicator.add_child(this._iconBox);

    // Header section of the popup menu
    // Sección de cabecera del menú desplegable (el que aparece cuando clicas)
    this._headerBox = new St.BoxLayout({
      style_class: "codexbar-header",
      vertical: false,
      x_expand: true,
    });
    this._headerTitle = new St.Label({
      text: _("CodexBar"),
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    this._headerBox.add_child(this._headerTitle);

    let refreshBtn = new St.Button({
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 16 }),
      style_class: "codexbar-header-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    refreshBtn.connect("clicked", () => this._refreshData());
    this._headerBox.add_child(refreshBtn);

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

    // Tabs for switching between different providers
    // Pestañas para cambiar entre diferentes proveedores
    this._tabsContainer = new St.BoxLayout({
      style_class: "codexbar-tabs-container",
      vertical: false,
    });
    this._indicator.menu.box.add_child(this._tabsContainer);

    // Main content area for usage stats
    // Área de contenido principal para las estadísticas de uso
    this._contentBox = new St.BoxLayout({
      vertical: true,
      style_class: "codexbar-usage-section",
    });
    this._indicator.menu.box.add_child(this._contentBox);

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._activeProviderIndex = 0;
    this._providersData = [];
    this._loading = false;
    this._cancellable = new Gio.Cancellable();

    // Standard signal handling
    // Manejo estándar de señales 
    this._settings.connectObject(
      "changed::providers", () => this._onSettingsChanged(),
      "changed::refresh-interval", () => this._onSettingsChanged(),
      "changed::display-mode", () => this._updateUI(),
      "changed::show-logos", () => this._updateUI(),
      "changed::show-pacing-info", () => this._updateUI(),
      "changed::first-run", () => this._updateUI(),
      "changed::dev-custom-output-enabled", () => this._onSettingsChanged(),
      "changed::dev-custom-output-provider-name", () => this._onSettingsChanged(),
      "changed::dev-custom-output-json", () => this._onSettingsChanged(),
      this
    );
    this._onSettingsChanged();
  }

  /**
   * Called when the extension is disabled.
   * Se llama cuando la extensión se desactiva.
   */
  disable() {
    // Step 1: Clean up the API client
    // Paso 1: Limpiar el cliente de la API
    if (this._apiClient) {
      this._apiClient.destroy();
      this._apiClient = null;
    }

    // Step 2: Cancel any pending subprocesses or async operations
    // Paso 2: Cancelar cualquier subproceso o operación asíncrona pendiente
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    // Step 3: Remove timeouts
    // Paso 3: Eliminar los timeouts
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._copyTimeouts) {
      this._copyTimeouts.forEach((id) => GLib.source_remove(id));
      this._copyTimeouts = null;
    }

    // Step 4: Disconnect all settings signals
    // Paso 4: Desconectar todas las señales de configuración
    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
    }

    // Step 5: Destroy all UI elements and the indicator
    // Paso 5: Destruir todos los elementos de la interfaz y el indicador
    if (this._iconFill) {
      this._iconFill.destroy();
      this._iconFill = null;
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
    if (this._tabsContainer) {
      this._tabsContainer.destroy();
      this._tabsContainer = null;
    }
    if (this._contentBox) {
      this._contentBox.destroy();
      this._contentBox = null;
    }
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    // Step 6: Nullify remaining references to prevent memory leaks
    // Paso 6: Anular referencias restantes para prevenir fugas de memoria
    this._providersData = [];
    this._activeProviderIndex = 0;

    // Step 7: Release schema references to prevent memory leaks
    // Paso 7: Liberar referencias de esquemas para prevenir fugas de memoria
    nullTokenSchema();

  }

  /**
   * Handle settings changes.
   * Manejar cambios en la configuración.
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

    this._refreshData();
    this._setupTimeout();
  }

  /**
   * Set up the auto-refresh timer.
   * Configura el temporizador de refresco automático.
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
          this._refreshData();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }
  }

 

  /**
   * Refresh usage data for all enabled providers.
   * Refrescar los datos de uso para todos los proveedores habilitados.
   */
  async _refreshData() {
    if (this._loading || this._providers.length === 0) return;
    this._loading = true;

    if (this._headerTitle)
      this._headerTitle.set_text(_("CodexBar (Refreshing...)"));

    logDev("Refreshing usage data...");

    // Intercept if developer custom output simulation is active
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

      this._loading = false;
      if (this._headerTitle) this._headerTitle.set_text(_("CodexBar"));
      this._updateUI();
      return;
    }

    this._providersData = [];

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];

      if (provider.useApi) {
        logDev(`Fetching API summary for provider: ${provider.name}`);
        try {
          let data;
          const token = await loadToken(provider.id);
          if (!token) {
            logDev(`Error: No token found in keyring for provider: ${provider.name}`);
            this._providersData[i] = { error: _("No token found in keyring") };
            continue;
          }
          data = await this._apiClient.fetchSummary(token, provider.id, this._cancellable);

          // Generate dynamic labels based on window durations
          // Generar etiquetas dinámicas basadas en las duraciones de las ventanas
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

          this._providersData[i] = {
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
          this._providersData[i] = { error: msg };
        }
        continue;
      }

      // Case 2: Provider uses CLI command (external codexbar tool)
      // Caso 2: El proveedor usa un comando CLI (herramienta codexbar externa)
      if (!provider.command) {
        logDev(`Error: No CLI command configured for provider: ${provider.name}`);
        this._providersData[i] = { error: _("No command configured") };
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

        this._providersData[i] = {
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
          this._providersData[i] = {
            error: msg,
            command: provider.command,
          };
        }
      }
    }

    if (this._cancellable && !this._cancellable.is_cancelled()) {
      this._loading = false;
      if (this._headerTitle) this._headerTitle.set_text(_("CodexBar"));
      this._updateUI();
    }
  }

  /**
   * Normalize percentage value.
   * Normaliza el valor del porcentaje.
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
   * Actualiza la interfaz del menú del indicador.
   */
  _updateUI() {
    if (!this._indicator) return;

    this._tabsContainer.destroy_all_children();
    this._contentBox.destroy_all_children();

    const displayMode = this._settings.get_string("display-mode");
    const firstRun = this._settings.get_boolean("first-run");

    // Check for CLI and Cookie Importer presence
    // Comprobar la presencia de la CLI y del importador de cookies
    const codexbarExists = this._checkBinaryExists("codexbar");
    const importerExists = this._checkBinaryExists("codexbar-cookie-importer");

    if (firstRun || !codexbarExists) {
      this._showWelcomeScreen(codexbarExists, importerExists);
      return;
    }

    // Recalculate active usage for the panel icon (average of all tiers)
    // Recalcular el uso activo para el icono del panel (media de todos los niveles)
    let totalPercent = 0;
    let tierCount = 0;

    const activeData = this._providersData[this._activeProviderIndex];
    if (activeData && activeData.data && activeData.data.usage) {
      const usage = activeData.data.usage;
      const tiers = ["primary", "secondary", "tertiary", "quaternary"];

      tiers.forEach((tier) => {
        if (usage[tier] && usage[tier].usedPercent !== undefined) {
          let p = this._normalizePercent(usage[tier].usedPercent);
          totalPercent += displayMode === "remaining" ? 100 - p : p;
          tierCount++;
        }
      });

      if (tierCount === 0 && usage.providerCost && usage.providerCost.limit > 0) {
        let p = (usage.providerCost.used / usage.providerCost.limit) * 100;
        totalPercent += displayMode === "remaining" ? 100 - p : p;
        tierCount++;
      }
    }

    let activePercent = tierCount > 0 ? totalPercent / tierCount : 0;

    // Create tab buttons
    // Crear botones de pestaña
    const showLogos = this._settings.get_boolean("show-logos");

    this._providers.forEach((provider, index) => {
      let btn = new St.Button({
        style_class: "codexbar-tab",
        can_focus: true,
      });

      let btnBin = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
      });
      btn.set_child(btnBin);

      if (showLogos) {
        const logoIcon = this._getProviderLogo(
          provider.id || provider.name.toLowerCase(),
        );
        if (logoIcon) {
          btnBin.add_child(logoIcon);
        }
      }

      btnBin.add_child(
        new St.Label({
          text: provider.name || _("Unknown"),
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );

      if (index === this._activeProviderIndex) {
        btn.add_style_class_name("codexbar-tab-active");
      }
      btn.connect("clicked", () => {
        this._activeProviderIndex = index;
        this._updateUI();
      });
      this._tabsContainer.add_child(btn);
    });

    // Apply fill to panel icon based on ACTIVE provider
    // Aplicar relleno al icono del panel basado en el proveedor ACTIVO
    if (this._iconFill) {
      // Interior width of the box (20px - 2*1.5px border - 2*1px padding = 15px)
      // Increased to 18 to ensure it looks "fuller" on various scales
      const totalFillWidth = 18;
      const fillWidth = Math.max(
        1,
        Math.min(
          totalFillWidth,
          Math.round((activePercent / 100) * totalFillWidth),
        ),
      );

      let color = "#3584e4"; // Adwaita Blue
      if (displayMode === "remaining") {
        if (activePercent < 10) color = "#e01b24";
        else if (activePercent < 25) color = "#ff7800";
        else if (activePercent < 50) color = "#f6d32d";
      } else {
        if (activePercent > 90) color = "#e01b24";
        else if (activePercent > 75) color = "#ff7800";
        else if (activePercent > 50) color = "#f6d32d";
      }

      this._iconFill.set_width(fillWidth);
      this._iconFill.set_style(`background-color: ${color};`);
    }

    if (this._providers.length === 0) {
      this._contentBox.add_child(
        new St.Label({ text: _("No providers configured. Click settings.") }),
      );
      return;
    }

    const activeProvider = this._providers[this._activeProviderIndex];
    // Reuse activeData already declared above
    // Reutilizar activeData ya declarada arriba

    if (!activeData) {
      this._contentBox.add_child(new St.Label({ text: _("Loading data...") }));
      return;
    }

    // Show error if any
    // Mostrar error si existe
    if (activeData.error) {
      let errorBox = new St.BoxLayout({ vertical: true, x_expand: true });

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

    // Account information
    // Información de la cuenta
    if (usage.accountEmail) {
      let accountBox = new St.BoxLayout({ vertical: true, margin_bottom: 15 });
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
        vertical: false,
        x_expand: true,
      });
      accountDetails.add_child(
        new St.Label({ text: accText, style_class: "codexbar-usage-subtitle" }),
      );
      if (usage.planType) {
        const planText =
          usage.planType.charAt(0).toUpperCase() + usage.planType.slice(1);
        accountDetails.add_child(
          new St.Label({
            text: planText,
            style_class: "codexbar-usage-subtitle",
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
          new St.Label({
            text: _("Updated %s").format(dateStr),
            style_class: "codexbar-usage-subtitle",
          }),
        );
      }
      this._contentBox.add_child(accountBox);
    }

    // Usage bars for each tier
    // Barras de uso para cada nivel
    const tiers = ["primary", "secondary", "tertiary", "quaternary"];
    const discoveredLabels = activeData.labels || [];
    let hasTiers = false;

    const usageEntries = tiers.map((tier, tierIdx) => ({
      data: usage[tier],
      showPace: true,
      title:
        discoveredLabels[tierIdx] ||
        tier.charAt(0).toUpperCase() + tier.slice(1),
    }));
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

        let progressContainer = new St.BoxLayout({
          style_class: "codexbar-progress-container",
        });
        let p = this._normalizePercent(tierData.usedPercent);

        let percent = displayMode === "remaining" ? 100 - p : p;
        let labelText =
          displayMode === "remaining"
            ? _("%s%% left").format(percent.toFixed(1))
            : _("%s%% used").format(percent.toFixed(1));

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

        const fullWidth = 290;
        const barWidth = Math.max(1, Math.round((percent / 100) * fullWidth));

        let progressBar = new St.Widget({
          style_class: "codexbar-progress-bar",
          style: `width: ${barWidth}px; background-color: ${color};`,
        });
        progressContainer.add_child(progressBar);
        this._contentBox.add_child(progressContainer);

        const statsBox = new St.BoxLayout({ vertical: false, x_expand: true });
        statsBox.add_child(
          new St.Label({
            text: labelText,
            style_class: "codexbar-usage-subtitle",
          }),
        );
        statsBox.add_child(
          new St.Label({
            text: tierData.resetDescription || "",
            style_class: "codexbar-usage-subtitle",
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
          }),
        );

        this._contentBox.add_child(statsBox);

        if (showPacing && entry.showPace && tierData.windowSeconds >= 7 * 24 * 3600) {
          const pace = calculateUsagePace(tierData);
          if (pace) {
            const roundedReserve = Math.round(pace.reservePercent);
            const paceBox = new St.BoxLayout({ vertical: false, x_expand: true });
            paceBox.add_child(
              new St.Label({
                text:
                  roundedReserve >= 0
                    ? _("%d%% in reserve").format(roundedReserve)
                    : _("%d%% over pace").format(Math.abs(roundedReserve)),
                style_class: "codexbar-usage-subtitle",
              }),
            );
            paceBox.add_child(
              new St.Label({
                text:
                  roundedReserve >= 0
                    ? _("Lasts until reset")
                    : _("May run out before reset"),
                style_class: "codexbar-usage-subtitle",
                x_align: Clutter.ActorAlign.END,
                x_expand: true,
              }),
            );
            this._contentBox.add_child(paceBox);
          }
        }

        let sep = new St.Widget({
          style:
            "height: 1px; background-color: rgba(255,255,255,0.05); margin-bottom: 10px; margin-top: 5px;",
        });
        this._contentBox.add_child(sep);
      }
    });

    if (usage.rateLimitResetCredits?.availableCount !== undefined) {
      const creditCount = usage.rateLimitResetCredits.availableCount;
      const creditsBox = new St.BoxLayout({
        vertical: true,
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
        new St.Label({
          text:
            creditCount === 1
              ? _("1 available")
              : _("%d available").format(creditCount),
          style_class: "codexbar-usage-subtitle",
        }),
      );
      this._contentBox.add_child(creditsBox);
    }

    if (!hasTiers && usage.providerCost) {
      let costBox = new St.BoxLayout({
        vertical: true,
        style_class: "codexbar-cost-container",
        x_expand: true,
      });

      let costTitleStr = usage.providerCost.period || _("Balance");
      let costTitle = new St.Label({
        text: costTitleStr,
        style_class: "codexbar-cost-title",
        x_align: Clutter.ActorAlign.CENTER,
      });
      costBox.add_child(costTitle);

      let formattedAmount = "";
      try {
        let currency = usage.providerCost.currencyCode || "USD";
        let used = usage.providerCost.used || 0;
        let limit = usage.providerCost.limit || 0;
        let formatter = new Intl.NumberFormat("en-US", {
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
   * Get provider logo as an St.Icon.
   * Obtener el logo del proveedor como un St.Icon.
   * @param {string} providerId
   * @returns {St.Icon|null}
   */
  _getProviderLogo(providerId) {
    if (!providerId) return null;

    // Normalize ID: lowercase and replace spaces with dashes
    const id = providerId.toLowerCase().replace(/\s+/g, "-");
    const logoPath = GLib.build_filenamev([
      this.path,
      "media",
      "logos",
      `${id}-symbolic.svg`,
    ]);

    if (GLib.file_test(logoPath, GLib.FileTest.EXISTS)) {
      const gicon = Gio.Icon.new_for_string(logoPath);

      let icon = new St.Icon({
        gicon: gicon,
        icon_size: 16,
        style_class: "codexbar-tab-icon",
      });

      return icon;
    }
    return null;
  }

  /**
   * Helper to create a command box with a Copy button.
   * Crea un contenedor con el comando y un botón para copiar al portapapeles.
   */
  _createCommandWithCopyButton(commandText) {
    let box = new St.BoxLayout({
      vertical: false,
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
    box.add_child(cmdLabel);

    let copyBtn = new St.Button({
      style:
        "padding: 2px 6px; background-color: rgba(255,255,255,0.1); border-radius: 3px; font-size: 0.8em; color: #ffffff;",
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
      vertical: true,
      x_expand: true,
      style: "padding: 12px; spacing: 10px;",
    });

    box.add_child(
      new St.Label({
        text: _("Welcome to CodexBar!"),
        style: "font-weight: bold; font-size: 1.25em; margin-bottom: 5px;",
      }),
    );

    box.add_child(
      new St.Label({
        text: _("Please configure your system dependencies:"),
        style: "font-size: 0.95em; color: #a6e3a1; margin-bottom: 10px;",
      }),
    );

    // --- Dependency 1: CodexBar CLI ---
    // --- Dependencia 1: CodexBar CLI ---
    let dep1Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep1Header = new St.BoxLayout({ vertical: false });

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
      new St.Label({
        text: _("Required to query AI usage metrics."),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!codexbarExists) {
      dep1Box.add_child(
        this._createCommandWithCopyButton("brew install steipete/tap/codexbar"),
      );
    }
    box.add_child(dep1Box);

    // --- Dependency 2: Cookie Importer for codex ---
    // --- Dependencia 2: Importador de Cookies para codex---
    let dep2Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep2Header = new St.BoxLayout({ vertical: false });

    let dep2StatusColor = importerExists ? "#2ec27e" : "#ff7800";
    let dep2StatusText = importerExists
      ? _("● Installed")
      : _("● Optional (only for codex users and only if you want not to find and copy manually a cookie value)");

    dep2Header.add_child(
      new St.Label({
        text: _("2. Cookie Importer (pip)  "),
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
      new St.Label({
        text: _("Enables browser auto cookie extraction for Codex (ChatGPT). This cookie is used to authenticate on the usage api of OpenAI"),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!importerExists) {
      dep2Box.add_child(
        this._createCommandWithCopyButton(
          "pip install codexbar-cookie-importer",
        ),
      );
    }
    box.add_child(dep2Box);

    // --- Dependency 3: SSL Helper (for Antigravity) ---
    // --- Dependencia 3: Asistente SSL (para Antigravity) ---
    let dep3Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep3Header = new St.BoxLayout({ vertical: false });

    // Verify if the certificate is already installed/trusted
    const systemCaCertsPath = "/usr/local/share/ca-certificates/antigravity.crt";
    const certInstalled = GLib.file_test(systemCaCertsPath, GLib.FileTest.EXISTS);
    let dep3StatusColor = certInstalled ? "#2ec27e" : "#ff7800";
    let dep3StatusText = certInstalled
      ? _("● Installed")
      : _("● Optional (for Antigravity)");

    dep3Header.add_child(
      new St.Label({
        text: _("3. AGY Server Certificate Trust Helper (pip)  "),
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
      new St.Label({
        text: _("Required to trust the local Antigravity server certificate. Requires privilegie elevation"),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!certInstalled) {
      dep3Box.add_child(
        this._createCommandWithCopyButton(
          "pip install codexbar-ssl-helper && codexbar-ssl-helper",
        ),
      );
    }
    box.add_child(dep3Box);



    // --- Buttons ---
    // --- Botones ---
    let btnBox = new St.BoxLayout({
      vertical: false,
      style: "margin-top: 10px;",
      x_align: Clutter.ActorAlign.CENTER,
    });

    // Tengo que actualizar la maldita documentación. La pasaré a una WIKI de GH.

   /* let docBtn = new St.Button({
      label: _("Documentation"),
      style_class: "codexbar-tab",
      style: "margin-right: 10px;",
    });
    docBtn.connect("clicked", () => {
      Gio.AppInfo.launch_default_for_uri(
        "https://help.inled.es/help/codexbar-gnome",
        null,
      );
    });
    btnBox.add_child(docBtn);
    */

    let closeBtn = new St.Button({
      label: _("Get Started!"),
      style_class: "codexbar-tab",
      style: "background-color: #3584e4;",
    });
    closeBtn.connect("clicked", () => {
      this._settings.set_boolean("first-run", false);
      this._refreshData();
    });
    btnBox.add_child(closeBtn);
    box.add_child(btnBox);

    this._contentBox.add_child(box);
  }
}
