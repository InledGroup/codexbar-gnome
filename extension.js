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
import { UsageApiClient } from "./usageApi.js";
import { loadToken, nullTokenSchema } from "./secret.js";

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
    this._settings = this.getSettings();
    this._apiClient = new UsageApiClient();

    // Main indicator button in the panel
    // Botón indicador principal en el panel
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
    // Sección de cabecera del menú desplegable
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
    this._signals = [];
    this._signals.push(
      this._settings.connect("changed::providers", () =>
        this._onSettingsChanged(),
      ),
    );
    this._signals.push(
      this._settings.connect("changed::refresh-interval", () =>
        this._onSettingsChanged(),
      ),
    );
    this._signals.push(
      this._settings.connect("changed::display-mode", () => this._updateUI()),
    );
    this._signals.push(
      this._settings.connect("changed::show-logos", () => this._updateUI()),
    );
    this._signals.push(
      this._settings.connect("changed::first-run", () => this._updateUI()),
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

    // Step 4: Disconnect all settings signals
    // Paso 4: Desconectar todas las señales de configuración
    if (this._settings) {
      this._signals.forEach((id) => this._settings.disconnect(id));
      this._signals = [];
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
      logError(e, "CodexBar: Failed to parse providers");
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

    this._providersData = [];

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];

      // Case 1: Provider uses Direct API (e.g. Codex)
      // Caso 1: El proveedor usa la API directa (ej. Codex)
      if (provider.useApi) {
        try {
          const token = loadToken(provider.id);

          if (!token) {
            this._providersData[i] = { error: _("No token found in keyring") };
            continue;
          }
          const data = await this._apiClient.fetchSummary(token);

          // Generate dynamic labels based on window durations
          // Generar etiquetas dinámicas basadas en las duraciones de las ventanas
          let apiLabels = [];
          ["primary", "secondary", "tertiary", "quaternary"].forEach((tier) => {
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
          });

          this._providersData[i] = {
            data: data,
            labels: apiLabels,
          };
        } catch (error) {
          logError(error, `CodexBar: API error for ${provider.name}`);
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
        this._providersData[i] = { error: _("No command configured") };
        continue;
      }

      try {
        // Find executable path
        let executable = "/home/linuxbrew/.linuxbrew/bin/codexbar";
        const commonPaths = [
          "/home/linuxbrew/.linuxbrew/bin/codexbar",
          `${GLib.get_home_dir()}/.local/bin/codexbar`,
          "/usr/local/bin/codexbar",
          "/usr/bin/codexbar",
        ];

        for (const path of commonPaths) {
          if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
            executable = path;
            break;
          }
        }

        let finalCommand = provider.command;
        if (
          provider.command.startsWith("codexbar") &&
          !provider.command.startsWith("/")
        ) {
          finalCommand = provider.command.replace("codexbar", executable);
        }

        const proc = Gio.Subprocess.new(
          ["bash", "-c", finalCommand],
          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        );

        const [stdout, stderr] = await new Promise((resolve, reject) => {
          proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            try {
              const [ok, out, err] = p.communicate_utf8_finish(res);
              resolve([out || "", err || ""]);
            } catch (e) {
              if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                resolve(["", ""]);
              else reject(e);
            }
          });
        });

        if (!this._cancellable || this._cancellable.is_cancelled()) return;

        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        this._providersData[i] = {
          stdout: trimmedStdout,
          stderr: trimmedStderr,
          command: finalCommand,
          labels: [],
        };

        // Automatic label detection for CLI providers
        // Detección automática de etiquetas para proveedores CLI
        try {
          let discoveryCommand = finalCommand
            .replace("--format json", "")
            .replace("--json-only", "")
            .replace("--json", "")
            .replace("--pretty", "");

          const dProc = Gio.Subprocess.new(
            ["bash", "-c", discoveryCommand],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
          );

          const [dStdout] = await new Promise((resolve) => {
            dProc.communicate_utf8_async(null, this._cancellable, (p, res) => {
              try {
                const [ok, out] = p.communicate_utf8_finish(res);
                resolve([out || ""]);
              } catch (e) {
                resolve([""]);
              }
            });
          });

          if (dStdout) {
            const lines = dStdout.split("\n");
            for (let line of lines) {
              const match = line.match(/^([^:]+):\s+\d+%/);
              if (match) {
                this._providersData[i].labels.push(match[1].trim());
              }
            }
          }
        } catch (discoveryErr) {
          log(
            `CodexBar: Label discovery failed for ${provider.name}: ${discoveryErr.message}`,
          );
        }

        if (
          trimmedStdout &&
          (trimmedStdout.startsWith("[") || trimmedStdout.startsWith("{"))
        ) {
          try {
            const parsed = JSON.parse(trimmedStdout);
            let rawData = Array.isArray(parsed) ? parsed[0] : parsed;

            if (rawData) {
              // Check if the provider is antigravity
              // Comprobar si el proveedor es antigravity
              const isAntigravity = provider.id === "antigravity" || rawData.provider === "antigravity";
              
              if (rawData.usage) {
                // Normalize the nested usage data
                // Normalizar los datos de uso anidados
                const normalized = this._apiClient.normalizeSummary(rawData.usage, isAntigravity);
                rawData.usage = normalized.usage;
                if (normalized.labels && normalized.labels.length > 0) {
                  this._providersData[i].labels = normalized.labels;
                }
              } else {
                // Treat the root object as usage data
                // Tratar el objeto raíz como datos de uso
                const normalized = this._apiClient.normalizeSummary(rawData, isAntigravity);
                rawData = { ...rawData, usage: normalized.usage };
                if (normalized.labels && normalized.labels.length > 0) {
                  this._providersData[i].labels = normalized.labels;
                }
              }
            }
            this._providersData[i].data = rawData;
          } catch (jsonErr) {
            this._providersData[i].error = _("JSON Error: %s").format(
              jsonErr.message,
            );
          }
        } else if (trimmedStderr) {
          this._providersData[i].error = _("CLI Error: %s").format(
            trimmedStderr.split("\n")[0],
          );
        } else if (trimmedStdout) {
          this._providersData[i].error = _("Output is not valid JSON");
        } else {
          this._providersData[i].error = _("No output from command");
        }
      } catch (error) {
        if (this._cancellable && !this._cancellable.is_cancelled()) {
          logError(error, `CodexBar: error running provider ${provider.name}`);
          this._providersData[i] = {
            error: error.message,
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
   * Update the indicator menu UI.
   * Actualiza la interfaz del menú del indicador.
   */
  _updateUI() {
    if (!this._indicator) return;

    this._tabsContainer.destroy_all_children();
    this._contentBox.destroy_all_children();

    const displayMode = this._settings.get_string("display-mode");
    const firstRun = this._settings.get_boolean("first-run");

    // Check for codexbar CLI presence
    // Comprobar la presencia de la CLI de codexbar
    let codexbarExists = false;
    const commonPaths = [
      "/home/linuxbrew/.linuxbrew/bin/codexbar",
      `${GLib.get_home_dir()}/.local/bin/codexbar`,
      "/usr/local/bin/codexbar",
      "/usr/bin/codexbar",
    ];
    for (const path of commonPaths) {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        codexbarExists = true;
        break;
      }
    }

    if (firstRun || !codexbarExists) {
      this._showWelcomeScreen(codexbarExists);
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
      accountBox.add_child(
        new St.Label({ text: accText, style_class: "codexbar-usage-subtitle" }),
      );

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

    tiers.forEach((tier, tierIdx) => {
      if (usage[tier] && usage[tier].usedPercent !== undefined) {
        let tierData = usage[tier];

        let tierTitle =
          discoveredLabels[tierIdx] ||
          tier.charAt(0).toUpperCase() + tier.slice(1);
        this._contentBox.add_child(
          new St.Label({
            text: tierTitle,
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

        let sep = new St.Widget({
          style:
            "height: 1px; background-color: rgba(255,255,255,0.05); margin-bottom: 10px; margin-top: 5px;",
        });
        this._contentBox.add_child(sep);
      }
    });
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
   * Show welcome screen for first-run or missing CLI.
   * Muestra la pantalla de bienvenida para la primera ejecución o si falta la CLI.
   */
  _showWelcomeScreen(codexbarExists) {
    let box = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      style: "padding: 10px;",
    });

    box.add_child(
      new St.Label({
        text: _("Welcome to CodexBar!"),
        style: "font-weight: bold; font-size: 1.2em; margin-bottom: 10px;",
      }),
    );

    if (!codexbarExists) {
      box.add_child(
        new St.Label({
          text: _("CodexBar CLI not found. Please install it:"),
          style: "margin-bottom: 5px;",
        }),
      );

      let cmdScroll = new St.ScrollView({
        style:
          "background-color: rgba(0,0,0,0.3); border-radius: 4px; padding: 10px; margin-bottom: 15px;",
      });
      cmdScroll.add_child(
        new St.Label({
          text: "brew install steipete/tap/codexbar",
          style: "font-family: monospace; color: #3584e4;",
        }),
      );
      box.add_child(cmdScroll);
    } else {
      box.add_child(
        new St.Label({
          text: _("CodexBar CLI is installed! Ready to configure."),
          style: "margin-bottom: 15px; color: #2ec27e;",
        }),
      );
    }

    box.add_child(
      new St.Label({
        text: _("Configuration Tips:"),
        style: "font-weight: bold; margin-bottom: 5px;",
      }),
    );

    const tips = [
      _("• Use absolute paths for commands."),
      _("• Ensure --format json is included."),
      _("• Read the full documentation online."),
    ];
    tips.forEach((tip) => {
      box.add_child(
        new St.Label({
          text: tip,
          style: "font-size: 0.9em; margin-bottom: 2px;",
        }),
      );
    });

    let docBtn = new St.Button({
      label: _("Read Documentation"),
      style_class: "codexbar-tab",
      style: "margin-top: 15px; background-color: #3584e4;",
      x_align: Clutter.ActorAlign.CENTER,
    });
    docBtn.connect("clicked", () => {
      Gio.app_info_launch_default_for_uri(
        "https://help.inled.es/codexbar-gnome",
        null,
      );
    });
    box.add_child(docBtn);

    let closeBtn = new St.Button({
      label: _("Get Started"),
      style_class: "codexbar-tab",
      style: "margin-top: 10px;",
      x_align: Clutter.ActorAlign.CENTER,
    });
    closeBtn.connect("clicked", () => {
      this._settings.set_boolean("first-run", false);
      this._refreshData();
    });
    box.add_child(closeBtn);

    this._contentBox.add_child(box);
  }
}
