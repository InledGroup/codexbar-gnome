import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { storeToken, loadToken, clearToken } from './secret.js';

/**
 * Predefined providers list.
 * Lista de proveedores predefinidos.
 */
const PREDEFINED_PROVIDERS = [
    { id: 'codex', name: 'Codex', useApi: true, defaultCommand: '' },
    { id: 'gemini', name: 'Gemini', useApi: false, defaultCommand: 'codexbar --provider gemini --source api --format json' },
    { id: 'deepseek', name: 'DeepSeek', useApi: false, defaultCommand: 'codexbar --provider deepseek --source api --format json' },
    { id: 'copilot', name: 'Copilot', useApi: false, defaultCommand: 'codexbar --provider copilot --source api --format json' },
    { id: 'openrouter', name: 'OpenRouter', useApi: false, defaultCommand: 'codexbar --provider openrouter --source api --format json' },
    { id: 'perplexity', name: 'Perplexity', useApi: false, defaultCommand: 'codexbar --provider perplexity --source api --format json' },
    { id: 'mistral', name: 'Mistral', useApi: false, defaultCommand: 'codexbar --provider mistral --source api --format json' },
];

/**
 * Preferences page for CodexBar.
 * Página de preferencias para CodexBar.
 */
const CodexBarPrefsPage = GObject.registerClass(
class CodexBarPrefsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: _('General'),
            icon_name: 'dialog-information-symbolic',
        });

        this._settings = settings;
        this._providerRows = [];

        this.add(this._buildSettingsGroup());
        this.add(this._buildProvidersGroup());
        this.add(this._buildMaintenanceGroup());
    }

    /**
     * Build the general settings group (Refresh interval, Display mode).
     * Construye el grupo de ajustes generales (Intervalo de refresco, Modo de visualización).
     */
    _buildSettingsGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Settings'),
        });

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh Interval (minutes)'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1440,
                step_increment: 1,
                value: this._settings.get_int('refresh-interval'),
            }),
        });
        this._settings.bind('refresh-interval', refreshRow.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(refreshRow);

        const displayModeRow = new Adw.ComboRow({
            title: _('Display Mode'),
            model: new Gtk.StringList({
                strings: [_('Used'), _('Remaining')],
            }),
            selected: this._settings.get_string('display-mode') === 'used' ? 0 : 1,
        });
        displayModeRow.connect('notify::selected', () => {
            this._settings.set_string('display-mode', displayModeRow.selected === 0 ? 'used' : 'remaining');
        });
        group.add(displayModeRow);

        return group;
    }

    /**
     * Build the AI providers configuration group.
     * Construye el grupo de configuración de proveedores de IA.
     */
    _buildProvidersGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('AI Providers'),
            description: _('Enable providers. Codex uses Direct API. Others use codexbar-cli with --source api.'),
        });

        const activeProvidersJson = this._settings.get_string('providers');
        let activeProviders = [];
        try {
            activeProviders = JSON.parse(activeProvidersJson);
        } catch (e) {
            activeProviders = [];
        }

        const saveProviders = () => {
            const newProviders = [];
            this._providerRows.forEach(row => {
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
                            storeToken(row._id, token);
                        }
                    }
                }
            });
            this._settings.set_string('providers', JSON.stringify(newProviders));
        };

        const createProviderRow = (info, activeData = null) => {
            const isEnabled = activeData !== null;
            
            // Handle command defaults and migrations
            // Manejar valores por defecto y migraciones de comandos
            let command = info.defaultCommand;
            if (activeData) {
                if (activeData.command && (activeData.command.includes('--provider') || info.useApi)) {
                    command = activeData.command;
                } else {
                    command = info.defaultCommand;
                }
            }
            
            const row = new Adw.ExpanderRow({
                title: info.name,
                subtitle: isEnabled ? _('Enabled') : _('Disabled'),
                expanded: isEnabled,
            });
            
            row._id = activeData ? activeData.id : info.id;
            row._name = info.name;
            row._useApi = info.useApi;

            const enabledSwitch = new Gtk.Switch({
                active: isEnabled,
                valign: Gtk.Align.CENTER,
            });
            enabledSwitch.connect('notify::active', () => {
                row.set_subtitle(enabledSwitch.active ? _('Enabled') : _('Disabled'));
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
                    placeholder_text: _('Authentication Cookie (starts with __Secure...)'),
                    text: loadToken(row._id) || '',
                });
                tokenEntry.connect('changed', () => {
                    storeToken(row._id, tokenEntry.get_text().trim());
                    saveProviders();
                });
                row._tokenEntry = tokenEntry;

                const importBtn = new Gtk.Button({
                    label: _('Auto-Login from Browser (Codex Only)'),
                    margin_top: 6,
                    tooltip_text: _('Uses a local Python script to extract cookies from Chrome/Brave. Works only for Codex.')
                });
                
                importBtn.connect('clicked', () => {
                    this._importFromBrowser(row._id, tokenEntry);
                });
                
                box.append(new Gtk.Label({ 
                    label: _('Session Cookies (Codex):'), 
                    xalign: 0,
                    css_classes: ['caption'] 
                }));
                box.append(tokenEntry);
                box.append(importBtn);
                box.append(new Gtk.Label({ 
                    label: _('Manual entry: Paste your session cookies here.'), 
                    xalign: 0,
                    css_classes: ['dim-label']
                }));
                row._commandEntry = new Gtk.Entry({ text: '' }); // Dummy
            } else {
                const commandEntry = new Gtk.Entry({
                    placeholder_text: _('CLI Command'),
                    text: command,
                });
                commandEntry.connect('changed', saveProviders);
                row._commandEntry = commandEntry;
                
                const labelBox = new Gtk.Box({ spacing: 6 });
                labelBox.append(new Gtk.Label({ label: _('CLI Command:'), xalign: 0 }));
                
                const resetBtn = new Gtk.Button({
                    label: _('Reset Default'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                resetBtn.connect('clicked', () => {
                    commandEntry.set_text(info.defaultCommand);
                    saveProviders();
                });
                labelBox.append(resetBtn);
                
                box.append(labelBox);
                box.append(commandEntry);
            }

            row.add_row(box);
            this._providerRows.push(row);
            return row;
        };

        const processedIds = new Set();
        const processedNames = new Set();

        // 1. Predefined Providers
        PREDEFINED_PROVIDERS.forEach(info => {
            const infoNameLower = info.name.toLowerCase();
            const activeData = activeProviders.find(p => p.id === info.id) || 
                               activeProviders.find(p => p.name.toLowerCase() === infoNameLower);
            
            if (activeData) {
                processedIds.add(activeData.id);
                processedNames.add(activeData.name.toLowerCase());
            }
            group.add(createProviderRow(info, activeData));
        });

        // 2. Custom Providers
        activeProviders.forEach(p => {
            const pNameLower = p.name.toLowerCase();
            if (!processedIds.has(p.id) && !processedNames.has(pNameLower)) {
                group.add(createProviderRow({
                    id: p.id,
                    name: p.name,
                    useApi: p.useApi || false,
                    defaultCommand: p.command
                }, p));
            }
        });

        return group;
    }

    /**
     * Build the maintenance/debug group.
     * Construye el grupo de mantenimiento/depuración.
     */
    _buildMaintenanceGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Maintenance'),
        });

        const setupBtnRow = new Adw.ActionRow({
            title: _('Show Welcome Screen'),
            subtitle: _('Reset first-run state'),
        });
        const setupBtn = new Gtk.Button({
            icon_name: 'help-about-symbolic',
            valign: Gtk.Align.CENTER,
        });
        setupBtn.connect('clicked', () => {
            this._settings.set_boolean('first-run', true);
        });
        setupBtnRow.add_suffix(setupBtn);
        group.add(setupBtnRow);

        return group;
    }

    /**
     * Import cookies from browser using local Python script.
     * Importa cookies desde el navegador usando un script de Python local.
     */
    async _importFromBrowser(providerId, tokenEntry) {
        // Find the script path
        const homeDir = GLib.get_home_dir();
        const extensionDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'codexbar@inled.es']);
        const possiblePaths = [
            GLib.build_filenamev([extensionDir, 'cookie_importer.py']),
            GLib.build_filenamev([homeDir, '.local', 'share', 'gnome-shell', 'extensions', 'codexbar@inled.es', 'cookie_importer.py']),
        ];
        
        let scriptPath = null;
        for (const p of possiblePaths) {
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
                scriptPath = p;
                break;
            }
        }

        if (!scriptPath) {
            return;
        }
        
        try {
            // Spawn Python script to extract cookies
            // Lanzar script de Python para extraer cookies
            const [success, pid, stdin, stdout, stderr] = GLib.spawn_async_with_pipes(
                null,
                ['/usr/bin/python3', scriptPath],
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );

            if (!success) return;

            GLib.close(stdin);
            GLib.close(stderr);

            const stdoutStream = new Gio.UnixInputStream({ fd: stdout, close_fd: true });
            const dataInputStream = new Gio.DataInputStream({ base_stream: stdoutStream });
            
            let [out, len] = dataInputStream.read_line(null);
            if (out) {
                const outStr = new TextDecoder().decode(out);
                const result = JSON.parse(outStr);
                
                if (result.error === 'DEPENDENCIES_MISSING') {
                    // Help user install missing dependencies
                    // Ayudar al usuario a instalar dependencias faltantes
                    const installCmd = `pkexec apt install python3-secretstorage python3-cryptography -y`;
                    GLib.spawn_command_line_async(installCmd);
                } else if (result.cookie_header) {
                    tokenEntry.set_text(result.cookie_header);
                    storeToken(providerId, result.cookie_header);
                }
            }
            
            stdoutStream.close(null);
            GLib.spawn_close_pid(pid);
        } catch (e) {
            logError(e, 'CodexBar: Error in _importFromBrowser');
        }
    }
});

/**
 * Main preferences entry point.
 * Punto de entrada principal para las preferencias.
 */
export default class CodexBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.add(new CodexBarPrefsPage(settings));
    }
}
