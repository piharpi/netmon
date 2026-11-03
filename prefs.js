import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const MODES = [
    ['full', 'Full — ↓ ↑ ping'],
    ['compact', 'Compact — ↓ ↑'],
    ['download', 'Download only — ↓'],
    ['icon', 'Icon only'],
];

export default class NetMonPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Network Monitor',
            icon_name: 'network-transmit-receive-symbolic',
        });
        window.add(page);

        const display = new Adw.PreferencesGroup({title: 'Display'});
        page.add(display);

        const modeRow = new Adw.ComboRow({
            title: 'Panel indicator',
            subtitle: 'What the top-bar shows',
            model: Gtk.StringList.new(MODES.map(m => m[1])),
        });
        const current = settings.get_string('display-mode');
        modeRow.selected = Math.max(0, MODES.findIndex(m => m[0] === current));
        modeRow.connect('notify::selected', () => {
            settings.set_string('display-mode', MODES[modeRow.selected][0]);
        });
        display.add(modeRow);

        const speed = new Adw.PreferencesGroup({
            title: 'Speed test',
            description: 'Uses Cloudflare’s open speed-test backend.',
        });
        page.add(speed);

        const dl = new Adw.SpinRow({
            title: 'Download size',
            subtitle: 'Payload downloaded per test (MB)',
            adjustment: new Gtk.Adjustment({lower: 5, upper: 200, step_increment: 5, page_increment: 25}),
        });
        speed.add(dl);
        settings.bind('speedtest-download-mb', dl, 'value', Gio.SettingsBindFlags.DEFAULT);

        const ul = new Adw.SpinRow({
            title: 'Upload size',
            subtitle: 'Payload uploaded per test (MB)',
            adjustment: new Gtk.Adjustment({lower: 2, upper: 100, step_increment: 2, page_increment: 10}),
        });
        speed.add(ul);
        settings.bind('speedtest-upload-mb', ul, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}
