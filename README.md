# Network Monitor Mini

GNOME Shell extension that shows network download/upload speed and ping latency in the top bar, with history graphs on click or hover and an on-demand speed test.

- Top bar label: `↓ 1.2 M/s  ↑ 340 K/s  45 ms`, refreshed every 2 seconds. Other display modes: compact `↓1.2M ↑340K`, download only `↓1.2M`, or an icon only.
- Hover the label (or click it) to open a menu with 3-minute graphs:
  - **Download**: current speed, average, peak and total received this session, with a dashed average line.
  - **Upload**: current speed, average, peak and total sent this session, with a dashed average line.
  - **Ping**: latency to `1.1.1.1`, with min/average/max and packet loss, and a dashed average line.
- **Speed test**: *Run speed test* in the menu measures latency, download and upload against Cloudflare's open speed-test backend (`speed.cloudflare.com`). The result appears in the menu as `↓ 95.3 Mbps  ↑ 21.0 Mbps  24 ms`. Click again to cancel. It only runs when you click it. Each run transfers the configured payload (25 MB down and 10 MB up by default).
- Speed graphs auto-scale to the busiest point in the window, so both idle and burst traffic stay readable.
- A hover-opened menu closes when the pointer leaves it; clicking while it is open keeps it pinned.
- Follows the light/dark style live: grid and text use the theme colors, and the graph colors switch to a brighter palette in dark mode.
- Throughput sums the physical interfaces (`en*`, `wl*`, …); loopback, Docker/bridge/VPN/virtual interfaces are left out. The busiest interface is named in the Download detail line.
- Ping runs `ping -c1 -W1` once per sample; a missed reply counts toward the packet-loss figure.

Settings: panel display mode, speed-test download and upload size.

GNOME Shell 50.

## Install

```bash
git clone https://github.com/piharpi/netmon ~/.local/share/gnome-shell/extensions/netmon@harpi
glib-compile-schemas ~/.local/share/gnome-shell/extensions/netmon@harpi/schemas
# log out and back in (Wayland), then:
gnome-extensions enable netmon@harpi
```

## Tested on

| | |
| --- | --- |
| Device | Lenovo ThinkPad E14 Gen 7 (21SX) |
| OS | Ubuntu 26.04.1 LTS, kernel 7.0.0-42-generic |
| Desktop | GNOME Shell 50.1, Wayland session |

## License

GPL-2.0-or-later
