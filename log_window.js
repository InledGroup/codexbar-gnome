// The log window contains all the logs of the extension and it shows up when you enable it on prefs
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const logFile = GLib.build_filenamev([
    GLib.get_user_cache_dir(),
    'codexbar-extension-dev.log'
]);

const app = new Adw.Application({
    application_id: 'es.inled.codexbar.logwindow'
});

app.connect('activate', () => {
    const win = new Adw.ApplicationWindow({
        application: app,
        title: 'CodexBar Developer Logs',
        default_width: 650,
        default_height: 450
    });

    const toolbarView = new Adw.ToolbarView();

    // --- Header Bar ---
    const headerBar = new Adw.HeaderBar({
        title_widget: new Adw.WindowTitle({
            title: 'CodexBar Developer Logs',
            subtitle: 'Real-time extension events'
        })
    });

    const clearBtn = new Gtk.Button({
        label: 'Clear Log',
        valign: Gtk.Align.CENTER
    });
    clearBtn.add_css_class('flat');
    headerBar.pack_end(clearBtn);

    toolbarView.add_top_bar(headerBar);

    // --- Content Area ---
    const scrolled = new Gtk.ScrolledWindow({
        vexpand: true,
        hexpand: true
    });
    scrolled.set_margin_top(12);
    scrolled.set_margin_bottom(12);
    scrolled.set_margin_start(12);
    scrolled.set_margin_end(12);
    scrolled.set_has_frame(true);

    const textView = new Gtk.TextView({
        editable: false,
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR
    });
    textView.set_margin_top(6);
    textView.set_margin_bottom(6);
    textView.set_margin_start(6);
    textView.set_margin_end(6);
    scrolled.set_child(textView);

    toolbarView.set_content(scrolled);
    win.set_content(toolbarView);
    win.present();

    let lastSize = 0;
    const file = Gio.File.new_for_path(logFile);

    const updateLog = () => {
        try {
            if (!GLib.file_test(logFile, GLib.FileTest.EXISTS)) {
                textView.get_buffer().set_text('No logs generated yet. Click refresh in the extension to trigger logs.', -1);
                return true;
            }

            const [ok, content] = GLib.file_get_contents(logFile);
            if (ok) {
                const text = new TextDecoder().decode(content);
                const buffer = textView.get_buffer();
                
                if (text.length !== lastSize) {
                    buffer.set_text(text, -1);
                    lastSize = text.length;

                    const mark = buffer.get_insert();
                    textView.scroll_to_mark(mark, 0.0, true, 0.5, 1.0);
                }
            }
        } catch (e) {
            console.error('Failed to read log file:', e);
        }
        return true;
    };

    clearBtn.connect('clicked', () => {
        try {
            if (GLib.file_test(logFile, GLib.FileTest.EXISTS)) {
                file.delete(null);
            }
            textView.get_buffer().set_text('', -1);
            lastSize = 0;
        } catch (e) {
            console.error('Failed to clear log file:', e);
        }
    });

    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, updateLog);
    updateLog();

    win.connect('close-request', () => {
        GLib.Source.remove(timeoutId);
    });
});

app.run([]);
