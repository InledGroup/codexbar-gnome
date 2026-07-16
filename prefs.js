import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Adw from "gi://Adw";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import {
  storeToken,
  loadToken,
  clearToken,
  nullTokenSchema,
} from "./secret.js";

/**
 * Predefined providers list.
 * Lista de proveedores predefinidos.
 */
const PREDEFINED_PROVIDERS = [
  { id: "codex", name: "Codex", useApi: true, defaultCommand: "" },
  {
    id: "claude",
    name: "Claude",
    useApi: false,
    defaultCommand: "codexbar --provider claude --source cli --format json",
  },
    {
    id: "antigravity",
    name: "Antigravity",
    useApi: false,
    defaultCommand:
      "codexbar --provider antigravity --source cli --format json",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    useApi: false,
    defaultCommand: "codexbar --provider gemini --source api --format json",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    useApi: false,
    defaultCommand: "codexbar --provider deepseek --source api --format json",
  },
  {
    id: "copilot",
    name: "Copilot",
    useApi: false,
    defaultCommand: "codexbar --provider copilot --source api --format json",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    useApi: false,
    defaultCommand: "codexbar --provider openrouter --source api --format json",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    useApi: false,
    defaultCommand: "codexbar --provider perplexity --source api --format json",
  },
  {
    id: "mistral",
    name: "Mistral",
    useApi: false,
    defaultCommand: "codexbar --provider mistral --source api --format json",
  },
];

/**
 * Preferences page for CodexBar.
 * Página de preferencias para CodexBar.
 */
const CodexBarPrefsPage = GObject.registerClass(
  class CodexBarPrefsPage extends Adw.PreferencesPage {
    _init(settings, extensionPath = null) {
      super._init({
        title: _("General"),
        icon_name: "dialog-information-symbolic",
      });

      this._settings = settings;
      this._extensionPath = extensionPath;
      this._providerRows = [];

      this.add(this._buildSettingsGroup());
      this.add(this._buildProvidersGroup());
      this.add(this._buildDeveloperGroup());
      this.add(this._buildContributeGroup());
      this.add(this._buildMaintenanceGroup());

      this.connect("destroy", () => {
        this._settings = null;
        this._providerRows = [];
      });
    }

    /**
     * Build the developer/testing group.
     * Construye el grupo de opciones de desarrollador/pruebas.
     */
    _buildDeveloperGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Developer & Testing Options"),
        description: _(
          "Simulate custom CLI outputs and view debug logs.",
        ),
      });

      // 1. Toggle Custom Output
      const enabledRow = new Adw.SwitchRow({
        title: _("Test with Custom Output"),
        subtitle: _(
          "Intercept CLI queries and return the custom JSON entered below",
        ),
        active: this._settings.get_boolean("dev-custom-output-enabled"),
      });
      this._settings.bind(
        "dev-custom-output-enabled",
        enabledRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(enabledRow);

      // 2. Mock Provider Name
      const providerNameRow = new Adw.EntryRow({
        title: _("Simulated Provider Name"),
        text: this._settings.get_string("dev-custom-output-provider-name") || "Mock Provider",
      });
      this._settings.bind(
        "dev-custom-output-provider-name",
        providerNameRow,
        "text",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(providerNameRow);

      // 3. Mock JSON Input
      const jsonRow = new Adw.ActionRow({
        title: _("Simulated CLI JSON Output"),
        subtitle: _("Paste the raw JSON output to test"),
      });
      
      const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 120,
        hexpand: true,
        vexpand: false,
      });
      scrolled.set_has_frame(true);
      
      const jsonView = new Gtk.TextView({
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD,
      });
      jsonView.get_buffer().set_text(
        this._settings.get_string("dev-custom-output-json") || "[]",
        -1,
      );
      jsonView.get_buffer().connect("changed", () => {
        const buffer = jsonView.get_buffer();
        const start = buffer.get_start_iter();
        const end = buffer.get_end_iter();
        const text = buffer.get_text(start, end, true).trim();
        this._settings.set_string("dev-custom-output-json", text);
      });

      scrolled.set_child(jsonView);
      
      const jsonBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
      });
      jsonBox.append(scrolled);
      
      jsonRow.add_suffix(jsonBox);
      group.add(jsonRow);

      // 4. Show Log Window Toggle
      const logWindowRow = new Adw.SwitchRow({
        title: _("Show Standalone Log Window"),
        subtitle: _(
          "Open a separate GTK window displaying real-time extension execution logs",
        ),
        active: this._settings.get_boolean("dev-show-log-window"),
      });
      this._settings.bind(
        "dev-show-log-window",
        logWindowRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(logWindowRow);

      return group;
    }

    /**
     * Build the contribute and contact group.
     * Construye el grupo de contribución y contacto.
     */
    _buildContributeGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Contribute & Contact"),
        description: _(
          "Support CodexBar development and get in touch with the team.",
        ),
      });

      // Pull Request / Contribute
      const prRow = new Adw.ActionRow({
        title: _("Add a New Provider"),
        subtitle: _(
          "Help the community by submitting a Pull Request on GitHub",
        ),
      });
      prRow.add_prefix(new Gtk.Image({ icon_name: "window-new-symbolic" }));

      const prBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      prBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri(
          "https://github.com/InledGroup/codexbar-gnome",
          null,
        );
      });
      prRow.add_suffix(prBtn);
      group.add(prRow);

      // Review on GNOME Extensions
      const reviewRow = new Adw.ActionRow({
        title: _("Leave a Review"),
        subtitle: _(
          "Rate us on the GNOME Extensions website or share it on social media!",
        ),
      });
      reviewRow.add_prefix(new Gtk.Image({ icon_name: "starred-symbolic" }));

      const reviewBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      reviewBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri(
          "https://extensions.gnome.org/extension/9841/codexbar/",
          null,
        );
      });
      reviewRow.add_suffix(reviewBtn);
      group.add(reviewRow);

      // Contact Inled
      const contactRow = new Adw.ActionRow({
        title: _("Contact Inled"),
        subtitle: _("Questions? Suggestions? Write to us at hi@inled.es"),
      });
      contactRow.add_prefix(
        new Gtk.Image({ icon_name: "mail-message-new-symbolic" }),
      );

      const contactBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      contactBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri("mailto:hi@inled.es", null);
      });
      contactRow.add_suffix(contactBtn);
      group.add(contactRow);

      // Visit Website
      const webRow = new Adw.ActionRow({
        title: _("Visit inled.es"),
        subtitle: _(
          "Discover more tools and projects that might interest you!",
        ),
      });
      webRow.add_prefix(new Gtk.Image({ icon_name: "web-browser-symbolic" }));

      const webBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
      });
      webBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri("https://inled.es", null);
      });
      webRow.add_suffix(webBtn);
      group.add(webRow);

      // Social Media
      const socialRow = new Adw.ActionRow({
        title: _("Join the Community"),
        subtitle: _("Follow us on social media for updates and support"),
      });
      socialRow.add_prefix(
        new Gtk.Image({ icon_name: "system-users-symbolic" }),
      );

      const socialBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        valign: Gtk.Align.CENTER,
      });

      const createSocialBtn = (name, url, tooltip) => {
        const iconPath = GLib.build_filenamev([
          this._extensionPath,
          "media",
          "logos",
          `${name}-symbolic.svg`,
        ]);
        const btn = new Gtk.Button({
          css_classes: ["flat"],
          tooltip_text: tooltip,
        });
        if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
          const gicon = Gio.Icon.new_for_string(iconPath);
          btn.set_child(new Gtk.Image({ gicon: gicon }));
        } else {
          btn.set_label(tooltip);
        }
        btn.connect("clicked", () => {
          Gio.AppInfo.launch_default_for_uri(url, null);
        });
        return btn;
      };

      socialBox.append(
        createSocialBtn(
          "discord",
          "https://discord.com/invite/PSeTkDMnr",
          "Discord",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "matrix",
          "https://matrix.to/#/!POXBFohLnmrKwRBxTi:matrix.org?via=matrix.org",
          "Matrix",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "mastodon",
          "https://mastodon.social/@inled",
          "Mastodon",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "youtube",
          "https://www.youtube.com/@inledgroup",
          "YouTube",
        ),
      );
      socialBox.append(
        createSocialBtn("x", "https://x.com/inledgroup", "X (Twitter)"),
      );

      socialRow.add_suffix(socialBox);
      group.add(socialRow);

      return group;
    }

    /**
     * Build the general settings group (Refresh interval, Display mode).
     * Construye el grupo de ajustes generales (Intervalo de refresco, Modo de visualización).
     */
    _buildSettingsGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Settings"),
      });

      const refreshRow = new Adw.SpinRow({
        title: _("Refresh Interval (minutes)"),
        adjustment: new Gtk.Adjustment({
          lower: 1,
          upper: 1440,
          step_increment: 1,
          value: this._settings.get_int("refresh-interval"),
        }),
      });
      this._settings.bind(
        "refresh-interval",
        refreshRow.adjustment,
        "value",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(refreshRow);

      const displayModeRow = new Adw.ComboRow({
        title: _("Display Mode"),
        model: new Gtk.StringList({
          strings: [_("Used"), _("Remaining")],
        }),
        selected: this._settings.get_string("display-mode") === "used" ? 0 : 1,
      });
      displayModeRow.connect("notify::selected", () => {
        this._settings.set_string(
          "display-mode",
          displayModeRow.selected === 0 ? "used" : "remaining",
        );
      });
      group.add(displayModeRow);

      const showLogosRow = new Adw.SwitchRow({
        title: _("Show Provider Logos"),
        subtitle: _(
          "Display the logo of each AI provider in the selection tabs",
        ),
        active: this._settings.get_boolean("show-logos"),
      });
      this._settings.bind(
        "show-logos",
        showLogosRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(showLogosRow);

      const showPacingInfoRow = new Adw.SwitchRow({
        title: _("Show Usage Pacing"),
        subtitle: _(
          "Display weekly pacing estimates (reserve or over pace) for large windows",
        ),
        active: this._settings.get_boolean("show-pacing-info"),
      });
      this._settings.bind(
        "show-pacing-info",
        showPacingInfoRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(showPacingInfoRow);

      return group;
    }

    /**
     * Build the AI providers configuration group.
     * Construye el grupo de configuración de proveedores de IA.
     */
    _buildProvidersGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("AI Providers"),
        description: _(
          "Enable providers. Codex uses Direct API. Others use codexbar-cli with --source api.",
        ),
      });

      const activeProvidersJson = this._settings.get_string("providers");
      let activeProviders = [];
      try {
        activeProviders = JSON.parse(activeProvidersJson);
      } catch (e) {
        activeProviders = [];
      }

      const saveProviders = async () => {
        const newProviders = [];
        for (const row of this._providerRows) {
          if (row._enabledSwitch.active) {
            newProviders.push({
              id: row._id,
              name: row._name,
              command: row._commandEntry.get_text(),
              useApi: row._useApi,
            });

            if (row._useApi) {
              const token = row._tokenEntry.get_text();
              if (token) {
                await storeToken(row._id, token);
              }
            }
          }
        }
        this._settings.set_string("providers", JSON.stringify(newProviders));
      };

      const createProviderRow = (info, activeData = null) => {
        const isEnabled = activeData !== null;
        const isPredefined = PREDEFINED_PROVIDERS.some((p) => p.id === info.id);

        // Handle command defaults and migrations
        // Manejar valores por defecto y migraciones de comandos
        let command = info.defaultCommand || "";
        if (activeData) {
          if (
            activeData.command &&
            (activeData.command.includes("--provider") ||
              info.useApi ||
              !isPredefined)
          ) {
            command = activeData.command;
          } else {
            command = info.defaultCommand;
          }
        }

        const row = new Adw.ExpanderRow({
          title: info.name,
          subtitle: isEnabled ? _("Enabled") : _("Disabled"),
          expanded: isEnabled,
        });

        row._id = activeData ? activeData.id : info.id;
        row._name = info.name;
        row._useApi = info.useApi;

        const enabledSwitch = new Gtk.Switch({
          active: isEnabled,
          valign: Gtk.Align.CENTER,
        });
        enabledSwitch.connect("notify::active", () => {
          row.set_subtitle(enabledSwitch.active ? _("Enabled") : _("Disabled"));
          row.expanded = enabledSwitch.active;
          saveProviders();
        });
        row.add_suffix(enabledSwitch);
        row._enabledSwitch = enabledSwitch;

        const box = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
          margin_top: 12,
          margin_bottom: 12,
          margin_start: 12,
          margin_end: 12,
        });

        if (info.useApi) {
          // For Direct API providers like Codex
          // Para proveedores de API directa como Codex
          const tokenEntry = new Gtk.PasswordEntry({
            placeholder_text: _(
              "Authentication Cookie (starts with __Secure...)",
            ),
          });
          loadToken(row._id).then((token) => {
            if (token) tokenEntry.set_text(token);
          }).catch(() => {});

          tokenEntry.connect("changed", async () => {
            await storeToken(row._id, tokenEntry.get_text().trim());
            saveProviders();
          });
          row._tokenEntry = tokenEntry;

          const importBtn = new Gtk.Button({
            label: _("Auto-Login from Browser (Codex Only)"),
            margin_top: 6,
            tooltip_text: _(
              "Uses a local Python script to extract cookies from Chrome/Brave. Works only for Codex.",
            ),
          });

          const spinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            margin_start: 6,
          });
          const btnBox = new Gtk.Box({ spacing: 6, margin_top: 6 });
          btnBox.append(importBtn);
          btnBox.append(spinner);

          importBtn.connect("clicked", () => {
            importBtn.sensitive = false;
            spinner.start();
            this._importFromBrowser(row._id, tokenEntry, () => {
              importBtn.sensitive = true;
              spinner.stop();
            });
          });

          box.append(
            new Gtk.Label({
              label: _("Session Cookies (Codex):"),
              xalign: 0,
              css_classes: ["caption"],
            }),
          );
          box.append(tokenEntry);
          box.append(btnBox);
          box.append(
            new Gtk.Label({
              label: _("Manual entry: Paste your session cookies here."),
              xalign: 0,
              css_classes: ["dim-label"],
            }),
          );
          row._commandEntry = new Gtk.Entry({ text: "" }); // Dummy
        } else {
          const commandEntry = new Gtk.Entry({
            placeholder_text: _("CLI Command (e.g. codexbar --provider ...)"),
            text: command,
          });
          commandEntry.connect("changed", saveProviders);
          row._commandEntry = commandEntry;

          const labelBox = new Gtk.Box({ spacing: 6 });
          labelBox.append(
            new Gtk.Label({ label: _("CLI Command:"), xalign: 0 }),
          );

          if (isPredefined) {
            const resetBtn = new Gtk.Button({
              label: _("Reset Default"),
              valign: Gtk.Align.CENTER,
              css_classes: ["flat"],
            });
            resetBtn.connect("clicked", () => {
              commandEntry.set_text(info.defaultCommand);
              saveProviders();
            });
            labelBox.append(resetBtn);
          }

          box.append(labelBox);
          box.append(commandEntry);

          if (info.id === "antigravity") {
            const hasLsof = !!GLib.find_program_in_path("lsof");

            if (!hasLsof) {
              let lsofCmd = "sudo apt install lsof";
              if (GLib.find_program_in_path("pacman")) {
                lsofCmd = "sudo pacman -S lsof";
              } else if (GLib.find_program_in_path("dnf")) {
                lsofCmd = "sudo dnf install lsof";
              }
              const lsofLabel = new Gtk.Label({
                label: _(
                  `⚠️ Antigravity requires the 'lsof' utility to detect the local server ports. Run this command to install it:\n\n${lsofCmd}`,
                ),
                xalign: 0,
                use_markup: false,
                wrap: true,
                css_classes: ["dim-label"],
              });
              lsofLabel.set_margin_top(6);
              box.append(lsofLabel);
            }

            // Antigravity SSL certificate setup instruction
            const certLabel = new Gtk.Label({
              label: _(
                "💡 Antigravity requires a trusted local SSL certificate to work. Run this command in terminal to set it up:\n\npip install codexbar-ssl-helper && codexbar-ssl-helper",
              ),
              xalign: 0,
              use_markup: false,
              wrap: true,
              css_classes: ["dim-label"],
            });
            certLabel.set_margin_top(12);
            box.append(certLabel);
          }
        }

        if (!isPredefined) {
          const deleteBtn = new Gtk.Button({
            label: _("Remove Provider"),
            margin_top: 12,
            css_classes: ["destructive-action"],
          });
          deleteBtn.connect("clicked", () => {
            group.remove(row);
            this._providerRows = this._providerRows.filter((r) => r !== row);
            saveProviders();
          });
          box.append(deleteBtn);
        }

        row.add_row(box);
        this._providerRows.push(row);
        return row;
      };

      const processedIds = new Set();
      const processedNames = new Set();

      // 1. Predefined Providers
      PREDEFINED_PROVIDERS.forEach((info) => {
        const infoNameLower = info.name.toLowerCase();
        const activeData =
          activeProviders.find((p) => p.id === info.id) ||
          activeProviders.find((p) => p.name.toLowerCase() === infoNameLower);

        if (activeData) {
          processedIds.add(activeData.id);
          processedNames.add(activeData.name.toLowerCase());
        }
        group.add(createProviderRow(info, activeData));
      });

      // 2. Custom Providers
      activeProviders.forEach((p) => {
        const pNameLower = p.name.toLowerCase();
        if (!processedIds.has(p.id) && !processedNames.has(pNameLower)) {
          group.add(
            createProviderRow(
              {
                id: p.id,
                name: p.name,
                useApi: p.useApi || false,
                defaultCommand: p.command,
              },
              p,
            ),
          );
        }
      });

      // 3. Add Custom Provider Button
      const addBtnRow = new Adw.ActionRow({
        title: _("Add Custom Provider"),
        subtitle: _("Specify a name and a codexbar CLI command"),
      });

      const addBtn = new Gtk.Button({
        icon_name: "list-add-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
      });

      addBtn.connect("clicked", () => {
        const dialog = new Adw.MessageDialog({
          heading: _("New Provider"),
          body: _("Enter the details for your custom AI provider."),
          transient_for: this.get_root(),
          modal: true,
        });

        const content = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 12,
        });

        const nameEntry = new Gtk.Entry({
          placeholder_text: _("Provider Name (e.g. MyLocalModel)"),
        });
        content.append(nameEntry);

        const cmdEntry = new Gtk.Entry({
          placeholder_text: _("Command (e.g. codexbar --provider ...)"),
        });
        content.append(cmdEntry);

        dialog.set_extra_child(content);
        dialog.add_response("cancel", _("Cancel"));
        dialog.add_response("add", _("Add"));
        dialog.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED);

        dialog.connect("response", (d, response) => {
          if (response === "add") {
            const name = nameEntry.get_text().trim();
            const cmd = cmdEntry.get_text().trim();
            if (name && cmd) {
              const newProvider = {
                id: `custom-${Date.now()}`,
                name: name,
                command: cmd,
                useApi: false,
              };
              const row = createProviderRow(
                {
                  id: newProvider.id,
                  name: newProvider.name,
                  useApi: false,
                  defaultCommand: newProvider.command,
                },
                newProvider,
              );
              // Add before the "Add Custom Provider" button
              // Añadir antes del botón "Añadir Proveedor Personalizado"
              group.add(row);
              // Manually move it up if needed, but Adw.PreferencesGroup appends
              // In GNOME 45+ we can't easily reorder children in PreferencesGroup
              // without removing the button and re-adding it.
              saveProviders();
            }
          }
        });
        dialog.present();
      });

      addBtnRow.add_suffix(addBtn);
      group.add(addBtnRow);

      return group;
    }

    /**
     * Build the maintenance/debug group.
     * Construye el grupo de mantenimiento/depuración.
     */
    _buildMaintenanceGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Maintenance"),
      });

      const setupBtnRow = new Adw.ActionRow({
        title: _("Show Welcome Screen"),
        subtitle: _("Reset first-run state"),
      });
      const setupBtn = new Gtk.Button({
        icon_name: "help-about-symbolic",
        valign: Gtk.Align.CENTER,
      });
      setupBtn.connect("clicked", () => {
        this._settings.set_boolean("first-run", true);
      });
      setupBtnRow.add_suffix(setupBtn);
      group.add(setupBtnRow);

      return group;
    }

    /**
     * Import cookies from browser using local Python script.
     * Importa cookies desde el navegador usando un script de Python local.
     */
    /**
     * Import cookies from browser using local Python script.
     * Importa cookies desde el navegador usando un script de Python local.
     */
    async _importFromBrowser(providerId, tokenEntry, callback = null) {
      const finish = () => {
        if (callback) callback();
      };

      const showError = (title, message) => {
        const dialog = new Adw.MessageDialog({
          heading: title,
          body: message,
          transient_for: this.get_root(),
          modal: true,
        });
        dialog.add_response("ok", _("OK"));
        dialog.present();
        finish();
      };

      const showMissingDialog = () => {
        const dialog = new Adw.MessageDialog({
          heading: _("Cookie Importer Missing"),
          body: _(
            "To import cookies automatically from your browser, please install the python dependency by running:\n\npip install codexbar-cookie-importer",
          ),
          transient_for: this.get_root(),
          modal: true,
        });
        dialog.add_response("ok", _("OK"));
        dialog.present();
        finish();
      };

      // Find the executable binary or fallback to python module
      // Encontrar el binario ejecutable o recurrir al módulo python
      let argv = null;
      if (GLib.find_program_in_path("codexbar-cookie-importer")) {
        argv = ["codexbar-cookie-importer"];
      } else {
        const localBin = GLib.build_filenamev([
          GLib.get_home_dir(),
          ".local",
          "bin",
          "codexbar-cookie-importer",
        ]);
        if (GLib.file_test(localBin, GLib.FileTest.EXISTS)) {
          argv = [localBin];
        } else {
          // Try executing as module / Intentar ejecutar como módulo
          argv = ["/usr/bin/python3", "-m", "codexbar_cookie_importer"];
        }
      }

      try {
        const proc = new Gio.Subprocess({
          argv: argv,
          flags:
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        const cancellable = new Gio.Cancellable();
        let timedOut = false;

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
          timedOut = true;
          cancellable.cancel();
          proc.force_exit();
          showError(
            _("Timeout"),
            _(
              "The cookie importer is taking too long. Please ensure your browser is closed and try again.",
            ),
          );
          return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, cancellable, async (p, res) => {
          if (timeoutId > 0 && !timedOut) {
            GLib.source_remove(timeoutId);
          }

          try {
            const [success, stdout, stderr] = p.communicate_utf8_finish(res);

            if (timedOut) return;

            // If the module is not found, python returns exit code 1 or 2 and No module named in stderr
            // Si el módulo no se encuentra, python devuelve código de salida 1 o 2 y No module named en stderr
            if (
              !success &&
              stderr &&
              (stderr.includes("No module named") ||
                stderr.includes("No such file"))
            ) {
              showMissingDialog();
              return;
            }

            if (success && stdout) {
              const result = JSON.parse(stdout.trim());

              if (result.error === "DEPENDENCIES_MISSING") {
                showMissingDialog();
              } else if (result.error) {
                showError(_("Import Failed"), result.details || result.error);
              } else if (result.cookie_header) {
                tokenEntry.set_text(result.cookie_header);
                await storeToken(providerId, result.cookie_header);

                const toast = new Adw.Toast({
                  title: _("Cookies imported successfully!"),
                });
                this.get_root().add_toast(toast);
                finish();
              }
            } else {
              const err = stderr || _("The importer returned no data.");
              if (err.includes("No module named")) {
                showMissingDialog();
              } else {
                showError(_("Error"), err);
              }
            }
          } catch (e) {
            if (!timedOut) {
              // Check if it's a module not found issue
              if (e.message && e.message.includes("No module named")) {
                showMissingDialog();
              } else {
                console.error(e, "CodexBar: Error reading importer output");
                showError(_("Unexpected Error"), e.message);
              }
            }
          }
        });
      } catch (e) {
        console.error(e, "CodexBar: Error in _importFromBrowser");
        showMissingDialog();
      }
    }

  }
);

/**
 * Main preferences entry point.
 * Punto de entrada principal para las preferencias.
 */
export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new CodexBarPrefsPage(settings, this.path);
    window.add(page);

    // Null out token schema when preferences window is closed
    // Anular el esquema del token cuando se cierre la ventana de preferencias
    window.connect("destroy", () => {
      nullTokenSchema();
    });
  }
}
