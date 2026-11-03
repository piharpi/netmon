import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const INTERVAL_SECS = 2;
const HISTORY = 90; // 90 x 2 seconds = 3 minutes
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 400;

const PING_HOST = '1.1.1.1';
const PING_TIMEOUT_SECS = 1;

// Floors so an idle line is not drawn full-scale
const SPEED_FLOOR = 64 * 1024; // 64 KiB/s
const PING_FLOOR = 50; // ms

// Virtual / internal interfaces to leave out of the throughput total
const SKIP_IFACE = /^(lo|veth|docker|br-|virbr|vnet|vbox|tun|tap|wg|lxc|lxd|bond|dummy|ifb|sit|gre)/;

const decoder = new TextDecoder();

const numbers = list => list.filter(v => v !== null);
const joinDetail = (...parts) => parts.filter(p => p).join('   ');
const average = list => {
    const nums = numbers(list);
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
};

function fmtRate(bytesPerSec) {
    if (bytesPerSec === null)
        return '–';
    const units = ['B/s', 'K/s', 'M/s', 'G/s'];
    let v = bytesPerSec, i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

const fmtMs = v => (v === null ? '–' : `${Math.round(v)} ms`);

// Compact rate: no space between number and unit, e.g. "1.2M"
function fmtRateTight(bytesPerSec) {
    if (bytesPerSec === null)
        return '–';
    const units = ['B', 'K', 'M', 'G'];
    let v = bytesPerSec, i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

// Cloudflare's open speed-test backend: no token, plain HTTP.
const CF_DOWN = 'https://speed.cloudflare.com/__down?bytes=';
const CF_UP = 'https://speed.cloudflare.com/__up';

class SpeedTester {
    constructor() {
        this._session = new Soup.Session();
        this._session.timeout = 30;
    }

    destroy() {
        try {
            this._session.abort();
        } catch {}
        this._session = null;
    }

    async _drain(stream, cancellable) {
        let total = 0;
        for (;;) {
            const bytes = await stream.read_bytes_async(
                65536, GLib.PRIORITY_DEFAULT, cancellable);
            const n = bytes.get_size();
            if (n === 0)
                break;
            total += n;
        }
        try {
            stream.close(null);
        } catch {}
        return total;
    }

    // Lowest of a few tiny round-trips, in ms.
    async latency(cancellable) {
        const samples = [];
        for (let i = 0; i < 5; i++) {
            const t = GLib.get_monotonic_time();
            const msg = Soup.Message.new('GET', `${CF_DOWN}0`);
            const stream = await this._session.send_async(
                msg, GLib.PRIORITY_DEFAULT, cancellable);
            await this._drain(stream, cancellable);
            samples.push((GLib.get_monotonic_time() - t) / 1000);
        }
        return Math.min(...samples);
    }

    // Returns Mbps.
    async download(bytes, cancellable) {
        const msg = Soup.Message.new('GET', `${CF_DOWN}${bytes}`);
        const t = GLib.get_monotonic_time();
        const stream = await this._session.send_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable);
        const total = await this._drain(stream, cancellable);
        const secs = (GLib.get_monotonic_time() - t) / 1e6;
        return secs > 0 ? (total * 8) / secs / 1e6 : 0;
    }

    // Returns Mbps.
    async upload(bytes, cancellable) {
        const payload = GLib.Bytes.new(new Uint8Array(bytes));
        const msg = Soup.Message.new('POST', CF_UP);
        msg.set_request_body_from_bytes('application/octet-stream', payload);
        const t = GLib.get_monotonic_time();
        await this._session.send_and_read_async(
            msg, GLib.PRIORITY_DEFAULT, cancellable);
        const secs = (GLib.get_monotonic_time() - t) / 1e6;
        return secs > 0 ? (bytes * 8) / secs / 1e6 : 0;
    }
}

async function readFile(path, cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
}

class Sampler {
    constructor(cancellable) {
        this._cancellable = cancellable;
        this._prev = null; // {time, rx, tx}
        this._ping = null; // in-flight ping subprocess
        this.down = [];
        this.up = [];
        this.ping = [];
        this.info = {totalRx: 0, totalTx: 0, iface: '', loss: 0};
    }

    async sample() {
        const c = this._cancellable;
        const [dev] = await Promise.all([
            readFile('/proc/net/dev', c),
            this._samplePing(c),
        ]);
        const net = this._parseNet(dev);
        this._push(this.down, net?.down ?? null);
        this._push(this.up, net?.up ?? null);
        const lost = this.ping.filter(v => v === null).length;
        this.info.loss = this.ping.length ? Math.round(100 * lost / this.ping.length) : 0;
    }

    _push(list, value) {
        list.push(value);
        if (list.length > HISTORY)
            list.shift();
    }

    _parseNet(text) {
        if (!text)
            return null;
        const now = GLib.get_monotonic_time() / 1e6; // seconds
        let rx = 0, tx = 0;
        let topName = '', topDelta = -1;
        const perIface = {};
        for (const line of text.split('\n').slice(2)) {
            const idx = line.indexOf(':');
            if (idx < 0)
                continue;
            const name = line.slice(0, idx).trim();
            if (SKIP_IFACE.test(name))
                continue;
            const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
            const irx = f[0], itx = f[8];
            if (!Number.isFinite(irx) || !Number.isFinite(itx))
                continue;
            rx += irx;
            tx += itx;
            perIface[name] = irx + itx;
        }

        const prev = this._prev;
        this._prev = {time: now, rx, tx, perIface};
        if (!prev)
            return null;
        const dt = now - prev.time;
        if (dt <= 0)
            return null;

        // Busiest interface this interval, for the detail line
        for (const name of Object.keys(perIface)) {
            const d = perIface[name] - (prev.perIface[name] ?? perIface[name]);
            if (d > topDelta) {
                topDelta = d;
                topName = name;
            }
        }
        this.info.iface = topName;

        const down = Math.max(0, (rx - prev.rx) / dt);
        const up = Math.max(0, (tx - prev.tx) / dt);
        this.info.totalRx += down * dt;
        this.info.totalTx += up * dt;
        return {down, up};
    }

    async _samplePing(cancellable) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['ping', '-n', '-q', '-c', '1', '-W', String(PING_TIMEOUT_SECS), PING_HOST],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            logError(e, 'netmon: could not launch ping');
            this._push(this.ping, null);
            return;
        }
        this._ping = proc;
        try {
            const [stdout] = await proc.communicate_utf8_async(null, cancellable);
            const m = stdout?.match(/=\s*[\d.]+\/([\d.]+)\//) // rtt min/avg/max from -q summary
                ?? stdout?.match(/time[=<]\s*([\d.]+)/);
            this._push(this.ping, m ? parseFloat(m[1]) : null);
        } catch {
            // Cancelled on disable, or ping failed: count as a lost sample
            if (!cancellable.is_cancelled())
                this._push(this.ping, null);
        } finally {
            if (this._ping === proc)
                this._ping = null;
        }
    }

    stopPing() {
        if (this._ping) {
            this._ping.force_exit();
            this._ping = null;
        }
    }
}

// [light theme, dark theme] from the GNOME palette
const COLORS = {
    down: [[0.15, 0.64, 0.41], [0.34, 0.89, 0.54]],
    up: [[0.21, 0.52, 0.89], [0.38, 0.63, 0.92]],
    ping: [[0.5, 0.3, 0.78], [0.72, 0.55, 0.95]],
};

const Graph = GObject.registerClass(
class Graph extends St.DrawingArea {
    _init(series, color, floor, showAvg) {
        super._init({style_class: 'netmon-graph'});
        this._series = series;
        this._color = color;
        this._floor = floor;
        this._showAvg = showAvg;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const values = this._series();

        // Auto-scale: fit the visible peak, never below the floor
        const nums = numbers(values);
        const peak = nums.length ? Math.max(...nums) : 0;
        const min = 0;
        const max = Math.max(peak * 1.15, this._floor);

        // Follow the theme text color so the grid shows on light and dark themes
        const fg = this.get_theme_node().get_foreground_color();
        const [fr, fg2, fb] = [fg.red / 255, fg.green / 255, fg.blue / 255];
        const dark = 0.299 * fr + 0.587 * fg2 + 0.114 * fb > 0.5;
        const [r, g, b] = this._color[dark ? 1 : 0];
        cr.setSourceRGBA(fr, fg2, fb, 0.06);
        cr.rectangle(0, 0, w, h);
        cr.fill();

        cr.setSourceRGBA(fr, fg2, fb, 0.12);
        cr.setLineWidth(1);
        for (const frac of [0.25, 0.5, 0.75]) {
            cr.moveTo(0, Math.round(h * frac) + 0.5);
            cr.lineTo(w, Math.round(h * frac) + 0.5);
        }
        cr.stroke();

        const step = w / (HISTORY - 1);
        const offset = HISTORY - values.length;
        const y = v => h - (Math.min(Math.max(v, min), max) - min) / (max - min) * (h - 2) - 1;
        const points = values
            .map((v, i) => (v === null ? null : [(offset + i) * step, y(v)]))
            .filter(p => p);

        if (points.length > 1) {
            cr.moveTo(points[0][0], h);
            points.forEach(([px, py]) => cr.lineTo(px, py));
            cr.lineTo(points.at(-1)[0], h);
            cr.closePath();
            cr.setSourceRGBA(r, g, b, 0.25);
            cr.fill();

            cr.moveTo(...points[0]);
            points.slice(1).forEach(([px, py]) => cr.lineTo(px, py));
            cr.setSourceRGBA(r, g, b, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        }

        const avg = this._showAvg ? average(values) : null;
        if (avg !== null && points.length > 1) {
            const ay = Math.round(y(avg)) + 0.5;
            cr.setDash([3, 3], 0);
            cr.setLineWidth(1);
            cr.setSourceRGBA(r, g, b, 0.8);
            cr.moveTo(points[0][0], ay);
            cr.lineTo(points.at(-1)[0], ay);
            cr.stroke();
            cr.setDash([], 0);
        }
        cr.$dispose();
    }
});

const Section = GObject.registerClass(
class Section extends PopupMenu.PopupBaseMenuItem {
    _init(title, series, color, floor, showAvg = false) {
        super._init({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'netmon-section',
            x_expand: true,
        });
        const header = new St.BoxLayout();
        header.add_child(new St.Label({text: title, style_class: 'netmon-title', x_expand: true}));
        this.value = new St.Label({style_class: 'netmon-value'});
        header.add_child(this.value);
        box.add_child(header);
        this.graph = new Graph(series, color, floor, showAvg);
        box.add_child(this.graph);
        this.detail = new St.Label({style_class: 'netmon-detail', opacity: 160});
        box.add_child(this.detail);
        this.add_child(box);
    }
});

const NetMonButton = GObject.registerClass(
class NetMonButton extends PanelMenu.Button {
    _init(ext, sampler) {
        super._init(0.5, 'Network Monitor');
        this._ext = ext;
        this._settings = ext.getSettings();
        this._sampler = sampler;
        this._tester = new SpeedTester();
        this._hoverOpened = false;
        this._hoverOpenId = 0;
        this._hoverPollId = 0;
        this._speedRunning = false;
        this._speedCancellable = null;

        // PanelMenu.Button only sizes/allocates its FIRST child, so icon and
        // label must live inside a single box.
        const panelBox = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._panelIcon = new St.Icon({
            icon_name: 'network-transmit-receive-symbolic',
            style_class: 'system-status-icon',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        panelBox.add_child(this._panelIcon);

        this._label = new St.Label({
            style_class: 'netmon-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(this._label);
        this.add_child(panelBox);

        const last = list => list.at(-1) ?? null;
        this._down = new Section('Download', () => sampler.down, COLORS.down, SPEED_FLOOR, true);
        this._up = new Section('Upload', () => sampler.up, COLORS.up, SPEED_FLOOR, true);
        this._ping = new Section('Ping', () => sampler.ping, COLORS.ping, PING_FLOOR, true);
        for (const s of [this._down, this._up, this._ping])
            this.menu.addMenuItem(s);
        this._last = last;

        // Speed test row (Cloudflare).
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._speedItem = new PopupMenu.PopupBaseMenuItem();
        this._speedLabel = new St.Label({
            text: 'Run speed test',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._speedItem.add_child(this._speedLabel);
        this._speedSpinner = new St.Icon({
            icon_name: 'content-loading-symbolic',
            style_class: 'popup-menu-icon',
            visible: false,
        });
        this._speedItem.add_child(this._speedSpinner);
        // Keep the menu open while testing: handle the press ourselves.
        this._speedItem.connect('button-press-event', () => {
            this._runSpeedTest();
            return Clutter.EVENT_STOP;
        });
        this.menu.addMenuItem(this._speedItem);

        this._speedResultItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._speedResult = new St.Label({
            text: 'Not run yet',
            style_class: 'netmon-detail',
            opacity: 160,
            x_expand: true,
        });
        this._speedResultItem.add_child(this._speedResult);
        this.menu.addMenuItem(this._speedResultItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Settings…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._settingsId = this._settings.connect(
            'changed::display-mode', () => this.update());

        // Click: if the menu was opened by hover, clicking pins it open
        this._clickGesture.set_enabled(false);
        this._click = new Clutter.ClickGesture();
        this._click.set_recognize_on_press(true);
        this._clickId = this._click.connect('recognize', () => {
            if (this.menu.isOpen && this._hoverOpened)
                this._stopHover();
            else
                this.menu.toggle();
        });
        this.add_action(this._click);

        this._hoverId = this.connect('notify::hover', () => this._onHover());
        this._menuStateId = this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                this._stopHover();
            else
                this._redrawGraphs();
        });
    }

    _onHover() {
        if (!this.hover || this.menu.isOpen || this._hoverOpenId)
            return;
        this._hoverOpenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_OPEN_MS, () => {
            this._hoverOpenId = 0;
            if (this.hover && !this.menu.isOpen) {
                this.menu.open();
                this._hoverOpened = true;
                this._startHoverPoll();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Close a hover-opened menu once the pointer leaves both button and menu
    _startHoverPoll() {
        let outsideSince = 0;
        this._hoverPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            const [x, y] = global.get_pointer();
            const inside = [this, this.menu.actor].some(actor => {
                const [ax, ay] = actor.get_transformed_position();
                const [aw, ah] = actor.get_transformed_size();
                return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
            });
            const now = GLib.get_monotonic_time() / 1000;
            if (inside) {
                outsideSince = 0;
            } else if (!outsideSince) {
                outsideSince = now;
            } else if (now - outsideSince >= HOVER_CLOSE_MS) {
                this._hoverPollId = 0;
                this.menu.close();
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopHover() {
        this._hoverOpened = false;
        if (this._hoverPollId) {
            GLib.source_remove(this._hoverPollId);
            this._hoverPollId = 0;
        }
    }

    _setSpeedStatus(text) {
        this._speedResult.text = text;
    }

    async _runSpeedTest() {
        if (this._speedRunning) {
            this._speedCancellable?.cancel();
            return;
        }
        this._speedRunning = true;
        this._speedLabel.text = 'Cancel speed test';
        this._speedSpinner.visible = true;
        this._speedCancellable = new Gio.Cancellable();
        const c = this._speedCancellable;
        const dlMb = this._settings.get_int('speedtest-download-mb');
        const upMb = this._settings.get_int('speedtest-upload-mb');

        try {
            this._setSpeedStatus('Measuring latency…');
            const lat = await this._tester.latency(c);
            if (c.is_cancelled())
                throw new Error('cancelled');

            this._setSpeedStatus(`${Math.round(lat)} ms  ·  testing download…`);
            const down = await this._tester.download(dlMb * 1024 * 1024, c);
            if (c.is_cancelled())
                throw new Error('cancelled');

            this._setSpeedStatus(
                `↓ ${down.toFixed(1)} Mbps  ·  ${Math.round(lat)} ms  ·  testing upload…`);
            const up = await this._tester.upload(upMb * 1024 * 1024, c);

            this._speedResult.text =
                `↓ ${down.toFixed(1)} Mbps   ↑ ${up.toFixed(1)} Mbps   ${Math.round(lat)} ms`;
        } catch (e) {
            this._speedResult.text = c.is_cancelled()
                ? 'Speed test cancelled'
                : 'Speed test failed';
        } finally {
            this._speedRunning = false;
            this._speedLabel.text = 'Run speed test';
            this._speedSpinner.visible = false;
            this._speedCancellable = null;
        }
    }

    update() {
        const s = this._sampler;
        const down = this._last(s.down), up = this._last(s.up), ping = this._last(s.ping);

        const mode = this._settings.get_string('display-mode');
        if (mode === 'icon') {
            this._panelIcon.visible = true;
            this._label.visible = false;
        } else {
            this._panelIcon.visible = false;
            this._label.visible = true;
            if (mode === 'compact')
                this._label.text = `↓${fmtRateTight(down)} ↑${fmtRateTight(up)}`;
            else if (mode === 'download')
                this._label.text = `↓${fmtRateTight(down)}`;
            else
                this._label.text = `↓ ${fmtRate(down)}  ↑ ${fmtRate(up)}  ${fmtMs(ping)}`;
        }

        const downs = numbers(s.down);
        this._down.value.text = fmtRate(down);
        this._down.detail.text = joinDetail(
            `avg ${fmtRate(average(s.down))}`,
            downs.length ? `peak ${fmtRate(Math.max(...downs))}` : '',
            `total ${fmtBytes(s.info.totalRx)}`);

        const ups = numbers(s.up);
        this._up.value.text = fmtRate(up);
        this._up.detail.text = joinDetail(
            `avg ${fmtRate(average(s.up))}`,
            ups.length ? `peak ${fmtRate(Math.max(...ups))}` : '',
            `total ${fmtBytes(s.info.totalTx)}`);

        const pings = numbers(s.ping);
        this._ping.value.text = fmtMs(ping);
        this._ping.detail.text = pings.length
            ? joinDetail(
                `min ${fmtMs(Math.min(...pings))}   avg ${fmtMs(average(pings))}   max ${fmtMs(Math.max(...pings))}`,
                s.info.loss ? `loss ${s.info.loss}%` : '',
                PING_HOST)
            : `no reply from ${PING_HOST}`;

        if (this.menu.isOpen)
            this._redrawGraphs();
    }

    _redrawGraphs() {
        for (const s of [this._down, this._up, this._ping])
            s.graph.queue_repaint();
    }

    destroy() {
        if (this._hoverOpenId)
            GLib.source_remove(this._hoverOpenId);
        this._hoverOpenId = 0;
        this._stopHover();
        this._speedCancellable?.cancel();
        this._tester?.destroy();
        this._tester = null;
        if (this._settingsId)
            this._settings.disconnect(this._settingsId);
        this._click.disconnect(this._clickId);
        this.menu.disconnect(this._menuStateId);
        this.disconnect(this._hoverId);
        super.destroy();
    }
});

export default class NetMonExtension extends Extension {
    enable() {
        this._cancellable = new Gio.Cancellable();
        this._busy = false;
        this._sampler = new Sampler(this._cancellable);
        this._button = new NetMonButton(this, this._sampler);
        Main.panel.addToStatusArea(this.uuid, this._button, 0, 'right');

        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_SECS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        const cancellable = this._cancellable;
        try {
            await this._sampler.sample();
            if (!cancellable.is_cancelled())
                this._button.update();
        } catch (e) {
            logError(e, 'netmon: sampling failed');
        } finally {
            if (cancellable === this._cancellable)
                this._busy = false;
        }
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;
        this._sampler.stopPing();
        GLib.source_remove(this._timerId);
        this._timerId = 0;
        this._button.destroy();
        this._button = null;
        this._sampler = null;
    }
}
