import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class CodexBarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        
        // Use a more descriptive name for the indicator
        this._indicator = new PanelMenu.Button(0.0, _('CodexBar'), false);
        
        this._iconBox = new St.BoxLayout({
            style_class: 'codexbar-panel-icon-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._iconFill = new St.Widget({
            style_class: 'codexbar-panel-icon-fill',
            x_expand: false,
            width: 0,
        });
        this._iconBox.add_child(this._iconFill);
        this._indicator.add_child(this._iconBox);

        this._headerBox = new St.BoxLayout({
            style_class: 'codexbar-header',
            vertical: false,
            x_expand: true,
        });
        this._headerTitle = new St.Label({
            text: _('CodexBar'),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._headerBox.add_child(this._headerTitle);
        
        let refreshBtn = new St.Button({
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 16 }),
            style_class: 'codexbar-header-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBtn.connect('clicked', () => this._refreshData());
        this._headerBox.add_child(refreshBtn);

        let settingsBtn = new St.Button({
            child: new St.Icon({ icon_name: 'preferences-system-symbolic', icon_size: 16 }),
            style_class: 'codexbar-header-button',
            y_align: Clutter.ActorAlign.CENTER,
        });
        settingsBtn.connect('clicked', () => {
            this.openPreferences();
            this._indicator.menu.close();
        });
        this._headerBox.add_child(settingsBtn);

        this._indicator.menu.box.add_child(this._headerBox);
        this._indicator.menu.box.add_style_class_name('codexbar-popup');

        this._tabsContainer = new St.BoxLayout({
            style_class: 'codexbar-tabs-container',
            vertical: false,
        });
        this._indicator.menu.box.add_child(this._tabsContainer);

        this._contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'codexbar-usage-section',
        });
        this._indicator.menu.box.add_child(this._contentBox);
        
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._activeProviderIndex = 0;
        this._providersData = [];
        this._loading = false;
        this._cancellable = new Gio.Cancellable();

        // Standard signal handling
        this._signals = [];
        this._signals.push(this._settings.connect('changed::providers', () => this._onSettingsChanged()));
        this._signals.push(this._settings.connect('changed::refresh-interval', () => this._onSettingsChanged()));
        this._signals.push(this._settings.connect('changed::display-mode', () => this._updateUI()));
        this._signals.push(this._settings.connect('changed::first-run', () => this._updateUI()));

        this._onSettingsChanged();
    }

    disable() {
        // Cancel any pending subprocesses
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settings) {
            this._signals.forEach(id => this._settings.disconnect(id));
            this._signals = [];
            this._settings = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        
        this._iconFill = null;
        this._iconBox = null;
        this._headerTitle = null;
        this._tabsContainer = null;
        this._contentBox = null;
    }

    _onSettingsChanged() {
        const providersJson = this._settings.get_string('providers');
        try {
            this._providers = JSON.parse(providersJson);
        } catch (e) {
            this._providers = [];
            logError(e, 'Failed to parse providers');
        }

        if (this._activeProviderIndex >= this._providers.length) {
            this._activeProviderIndex = 0;
        }

        this._refreshData();
        this._setupTimeout();
    }

    _setupTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
        }
        const interval = this._settings.get_int('refresh-interval') * 60 * 1000;
        if (interval > 0) {
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
                this._refreshData();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    async _refreshData() {
        if (this._loading || this._providers.length === 0) return;
        this._loading = true;
        this._headerTitle.set_text(_('CodexBar (Refreshing...)'));

        this._providersData = [];
        
        for (let i = 0; i < this._providers.length; i++) {
            const provider = this._providers[i];
            
            if (!provider.command) {
                this._providersData[i] = { error: _('No command configured') };
                continue;
            }

            try {
                let executable = '/home/linuxbrew/.linuxbrew/bin/codexbar';
                const commonPaths = [
                    '/home/linuxbrew/.linuxbrew/bin/codexbar',
                    `${GLib.get_home_dir()}/.local/bin/codexbar`,
                    '/usr/local/bin/codexbar',
                    '/usr/bin/codexbar'
                ];
                
                for (const path of commonPaths) {
                    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                        executable = path;
                        break;
                    }
                }

                let finalCommand = provider.command;
                if (provider.command.startsWith('codexbar') && !provider.command.startsWith('/')) {
                    finalCommand = provider.command.replace('codexbar', executable);
                }
                
                const proc = Gio.Subprocess.new(
                    ['bash', '-c', finalCommand],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                const [stdout, stderr] = await new Promise((resolve, reject) => {
                    proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                        try {
                            const [ok, out, err] = p.communicate_utf8_finish(res);
                            resolve([out || '', err || '']);
                        } catch (e) {
                            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                                resolve(['', '']);
                            else
                                reject(e);
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

                // Automatic label detection
                try {
                    let discoveryCommand = finalCommand
                        .replace('--format json', '')
                        .replace('--json-only', '')
                        .replace('--json', '')
                        .replace('--pretty', '');
                    
                    const dProc = Gio.Subprocess.new(
                        ['bash', '-c', discoveryCommand],
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                    );

                    const [dStdout] = await new Promise((resolve) => {
                        dProc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                            try {
                                const [ok, out] = p.communicate_utf8_finish(res);
                                resolve([out || '']);
                            } catch (e) {
                                resolve(['']);
                            }
                        });
                    });

                    if (dStdout) {
                        const lines = dStdout.split('\n');
                        for (let line of lines) {
                            const match = line.match(/^([^:]+):\s+\d+%/);
                            if (match) {
                                this._providersData[i].labels.push(match[1].trim());
                            }
                        }
                    }
                } catch (discoveryErr) {
                    log(`CodexBar: Label discovery failed for ${provider.name}: ${discoveryErr.message}`);
                }

                if (trimmedStdout && (trimmedStdout.startsWith('[') || trimmedStdout.startsWith('{'))) {
                    try {
                        const parsed = JSON.parse(trimmedStdout);
                        this._providersData[i].data = Array.isArray(parsed) ? parsed[0] : parsed;
                    } catch (jsonErr) {
                        this._providersData[i].error = _('JSON Error: %s').format(jsonErr.message);
                    }
                } else if (trimmedStderr) {
                    this._providersData[i].error = _('CLI Error: %s').format(trimmedStderr.split('\n')[0]);
                } else if (trimmedStdout) {
                    this._providersData[i].error = _('Output is not valid JSON');
                } else {
                    this._providersData[i].error = _('No output from command');
                }

            } catch (error) {
                if (this._cancellable && !this._cancellable.is_cancelled()) {
                    logError(error, `CodexBar error running provider ${provider.name}`);
                    this._providersData[i] = { error: error.message, command: provider.command };
                }
            }
        }

        if (this._cancellable && !this._cancellable.is_cancelled()) {
            this._loading = false;
            this._headerTitle.set_text(_('CodexBar'));
            this._updateUI();
        }
    }

    _normalizePercent(value) {
        if (value === undefined || value === null) return 0;
        let p = parseFloat(value);
        return Math.min(100, Math.max(0, p));
    }

    _updateUI() {
        if (!this._indicator) return;

        this._tabsContainer.destroy_all_children();
        this._contentBox.destroy_all_children();
        
        const displayMode = this._settings.get_string('display-mode');
        const firstRun = this._settings.get_boolean('first-run');
        
        let codexbarExists = false;
        const commonPaths = [
            '/home/linuxbrew/.linuxbrew/bin/codexbar',
            `${GLib.get_home_dir()}/.local/bin/codexbar`,
            '/usr/local/bin/codexbar',
            '/usr/bin/codexbar'
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

        let totalFillWidth = 16;
        let activePercent = 0;

        this._providers.forEach((provider, index) => {
            let btn = new St.Button({
                label: provider.name || _('Unknown'),
                style_class: 'codexbar-tab',
                can_focus: true,
            });
            if (index === this._activeProviderIndex) {
                btn.add_style_class_name('codexbar-tab-active');
                
                const activeData = this._providersData[index];
                if (activeData && activeData.data && activeData.data.usage && activeData.data.usage.primary) {
                    let p = this._normalizePercent(activeData.data.usage.primary.usedPercent);
                    activePercent = (displayMode === 'remaining') ? (100 - p) : p;
                }
            }
            btn.connect('clicked', () => {
                this._activeProviderIndex = index;
                this._updateUI();
            });
            this._tabsContainer.add_child(btn);
        });

        // Apply fill to panel icon based on ACTIVE provider
        const fillWidth = Math.round((activePercent / 100) * totalFillWidth);
        this._iconFill.set_width(fillWidth);
        
        let color = '#eeeeee';
        if (displayMode === 'remaining') {
            if (activePercent < 10) color = '#e01b24';
            else if (activePercent < 25) color = '#ff7800';
        } else {
            if (activePercent > 90) color = '#e01b24';
            else if (activePercent > 75) color = '#ff7800';
        }
        this._iconFill.set_style(`background-color: ${color};`);

        if (this._providers.length === 0) {
            this._contentBox.add_child(new St.Label({ text: _('No providers configured. Click settings.') }));
            return;
        }

        const activeProvider = this._providers[this._activeProviderIndex];
        const activeData = this._providersData[this._activeProviderIndex];

        if (!activeData) {
            this._contentBox.add_child(new St.Label({ text: _('Loading data...') }));
            return;
        }

        if (activeData.error) {
            let errorBox = new St.BoxLayout({ vertical: true, x_expand: true });

            let title = new St.Label({ 
                text: _('Error: %s').format(activeData.error),
                style: 'color: #ff7800; font-weight: bold; margin-bottom: 10px;',
            });
            errorBox.add_child(title);

            if (activeData.stderr) {
                errorBox.add_child(new St.Label({ text: _('Stderr:'), style: 'font-weight: bold; font-size: 0.8em; margin-top: 5px;' }));
                let scroll = new St.ScrollView({ hscrollbar_policy: St.PolicyType.AUTOMATIC, vscrollbar_policy: St.PolicyType.NEVER, style: 'background-color: rgba(0,0,0,0.2); border-radius: 4px; padding: 5px;' });
                scroll.add_child(new St.Label({ text: activeData.stderr, style: 'font-family: monospace; font-size: 0.8em;' }));
                errorBox.add_child(scroll);
            }

            this._contentBox.add_child(errorBox);
            return;
        }

        const data = activeData.data;
        if (!data || !data.usage) {
            this._contentBox.add_child(new St.Label({ text: _('Invalid JSON format (missing usage)') }));
            return;
        }

        const usage = data.usage;

        if (usage.accountEmail) {
            let accountBox = new St.BoxLayout({ vertical: true, margin_bottom: 15 });
            accountBox.add_child(new St.Label({ text: activeProvider.name, style_class: 'codexbar-usage-title', style: 'font-size: 1.1em;' }));
            let accText = usage.accountEmail;
            if (usage.loginMethod) accText += ` (${usage.loginMethod})`;
            accountBox.add_child(new St.Label({ text: accText, style_class: 'codexbar-usage-subtitle' }));
            
            if (usage.updatedAt) {
                let date = new Date(usage.updatedAt);
                let dateStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                accountBox.add_child(new St.Label({ text: _('Updated %s').format(dateStr), style_class: 'codexbar-usage-subtitle' }));
            }
            this._contentBox.add_child(accountBox);
        }

        const tiers = ['primary', 'secondary', 'tertiary', 'quaternary'];
        const discoveredLabels = activeData.labels || [];
        
        tiers.forEach((tier, tierIdx) => {
            if (usage[tier] && usage[tier].usedPercent !== undefined) {
                let tierData = usage[tier];
                
                let tierTitle = discoveredLabels[tierIdx] || (tier.charAt(0).toUpperCase() + tier.slice(1));
                this._contentBox.add_child(new St.Label({ text: tierTitle, style_class: 'codexbar-usage-title' }));
                
                let progressContainer = new St.BoxLayout({ style_class: 'codexbar-progress-container' });
                let p = this._normalizePercent(tierData.usedPercent);
                
                let percent = (displayMode === 'remaining') ? (100 - p) : p;
                let labelText = (displayMode === 'remaining') ? _('%s%% left').format(percent.toFixed(1)) : _('%s%% used').format(percent.toFixed(1));
                
                let color = '#3584e4';
                if (displayMode === 'remaining') {
                    if (percent < 10) color = '#e01b24';
                    else if (percent < 25) color = '#ff7800';
                    else if (percent < 50) color = '#f6d32d';
                } else {
                    if (percent > 90) color = '#e01b24';
                    else if (percent > 75) color = '#ff7800';
                    else if (percent > 50) color = '#f6d32d';
                }
                
                const fullWidth = 290; 
                const barWidth = Math.max(1, Math.round((percent / 100) * fullWidth));

                let progressBar = new St.Widget({
                    style_class: 'codexbar-progress-bar',
                    style: `width: ${barWidth}px; background-color: ${color};`,
                });
                progressContainer.add_child(progressBar);
                this._contentBox.add_child(progressContainer);

                const statsBox = new St.BoxLayout({ vertical: false, x_expand: true });
                statsBox.add_child(new St.Label({ text: labelText, style_class: 'codexbar-usage-subtitle' }));
                statsBox.add_child(new St.Label({ text: tierData.resetDescription || '', style_class: 'codexbar-usage-subtitle', x_align: Clutter.ActorAlign.END, x_expand: true }));
                
                this._contentBox.add_child(statsBox);
                
                let sep = new St.Widget({ style: 'height: 1px; background-color: rgba(255,255,255,0.05); margin-bottom: 10px; margin-top: 5px;' });
                this._contentBox.add_child(sep);
            }
        });
    }

    _showWelcomeScreen(codexbarExists) {
        let box = new St.BoxLayout({ vertical: true, x_expand: true, style: 'padding: 10px;' });
        
        box.add_child(new St.Label({ 
            text: _('Welcome to CodexBar!'), 
            style: 'font-weight: bold; font-size: 1.2em; margin-bottom: 10px;' 
        }));

        if (!codexbarExists) {
            box.add_child(new St.Label({ 
                text: _('CodexBar CLI not found. Please install it:'), 
                style: 'margin-bottom: 5px;' 
            }));
            
            let cmdScroll = new St.ScrollView({ style: 'background-color: rgba(0,0,0,0.3); border-radius: 4px; padding: 10px; margin-bottom: 15px;' });
            cmdScroll.add_child(new St.Label({ 
                text: 'brew install steipete/tap/codexbar', 
                style: 'font-family: monospace; color: #3584e4;' 
            }));
            box.add_child(cmdScroll);
        } else {
            box.add_child(new St.Label({ 
                text: _('CodexBar CLI is installed! Ready to configure.'), 
                style: 'margin-bottom: 15px; color: #2ec27e;' 
            }));
        }

        box.add_child(new St.Label({ 
            text: _('Configuration Tips:'), 
            style: 'font-weight: bold; margin-bottom: 5px;' 
        }));
        
        const tips = [
            _('• Use absolute paths for commands.'),
            _('• Ensure --format json is included.'),
            _('• Read the full documentation online.')
        ];
        tips.forEach(tip => {
            box.add_child(new St.Label({ text: tip, style: 'font-size: 0.9em; margin-bottom: 2px;' }));
        });

        let docBtn = new St.Button({
            label: _('Read Documentation'),
            style_class: 'codexbar-tab',
            style: 'margin-top: 15px; background-color: #3584e4;',
            x_align: Clutter.ActorAlign.CENTER
        });
        docBtn.connect('clicked', () => {
            Gio.app_info_launch_default_for_uri('https://help.inled.es/codexbar-gnome', null);
        });
        box.add_child(docBtn);

        let closeBtn = new St.Button({
            label: _('Get Started'),
            style_class: 'codexbar-tab',
            style: 'margin-top: 10px;',
            x_align: Clutter.ActorAlign.CENTER
        });
        closeBtn.connect('clicked', () => {
            this._settings.set_boolean('first-run', false);
            this._refreshData();
        });
        box.add_child(closeBtn);

        this._contentBox.add_child(box);
    }
}
