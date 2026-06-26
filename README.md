# Sonos Controller for Elgato Stream Deck

Full Sonos playback control for your Stream Deck — cover art, volume, track info, and more.

<!-- TODO: Replace with a banner screenshot of the plugin in action -->
<!-- ![Banner](docs/images/banner.png) -->

---

## Overview

This plugin brings Sonos speaker control directly to your Elgato Stream Deck. It supports both key buttons and the Stream Deck+ dial/LCD panel. Every action updates in real time as you play music — cover art, track titles, volume level, and playback state all reflect the current state of your speaker.

---

## Requirements

- **Elgato Stream Deck** — any model for key actions; **Stream Deck+** required for dial actions
- **Stream Deck software** — version 6.4 or later
- **Sonos system** — any Sonos speaker on the same local network as your computer
- **Network** — plugin and speaker must be on the same subnet (no VLAN isolation)

---

## Actions

### Play / Pause Key

Toggles playback on your Sonos speaker. Displays the current album or radio station cover art while playing.

<!-- TODO: Screenshot of the key showing cover art while playing -->
<!-- ![Play Pause Key](docs/images/action-play-pause.png) -->

**Settings:**
| Option | Description |
|--------|-------------|
| Device | Which Sonos speaker to control |
| Show cover art | Display album art on the key while playing |
| Show track title | Scroll the track title and artist across the key |
| Font color | Color for the scrolling title text |
| Font size | Size of the title text (px) |

---

### Track Dial *(Stream Deck+ only)*

The centerpiece of the plugin. The LCD panel displays:

- **Blurred cover art backdrop** — fills the full 200×100 panel with atmospheric color
- **Album or station cover** — sharp on the right, with rounded corners
- **Scrolling track title** — marquee animation for long titles
- **Artist name**
- **Progress bar** — shows real playback position in the dominant cover color; radio stations show a static separator
- **Equalizer bars** — 10 animated bars while playing, colored to match the cover art (luminance-corrected for dark covers)
- **Status** — play/pause state and current volume

The volume indicator bar at the bottom reflects the exact speaker volume.

<!-- TODO: Screenshot of the Track Dial panel while playing -->
<!-- ![Track Dial Playing](docs/images/action-dial-track-playing.png) -->

<!-- TODO: Screenshot of the Track Dial panel while paused (dimmed state) -->
<!-- ![Track Dial Paused](docs/images/action-dial-track-paused.png) -->

<!-- TODO: Screenshot showing a radio station with blurred logo backdrop -->
<!-- ![Track Dial Radio](docs/images/action-dial-track-radio.png) -->

**Dial interaction:**
| Action | Effect |
|--------|--------|
| Rotate | Adjust volume (±1% per tick, ±2% for fast rotation) |
| Press | Toggle mute |
| Touch | Toggle play / pause |

**Settings:**
| Option | Description |
|--------|-------------|
| Device | Which Sonos speaker to control |
| Show track title | Display title and artist on the panel |
| Font color | Color for the title text (default: white) |
| Font size | Size of the title text |
| Marquee speed | Scroll speed for long titles |
| Marquee pause | How long to pause at the start before scrolling |

---

### Volume Dial *(Stream Deck+ only)*

Dedicated volume control with mute support.

<!-- TODO: Screenshot of the Volume Dial LCD panel -->
<!-- ![Volume Dial](docs/images/action-dial-volume.png) -->

**Dial interaction:**
| Action | Effect |
|--------|--------|
| Rotate | Adjust volume |
| Press | Toggle mute |
| Touch | Set volume to configured preset |

---

### Volume Key

Increase, decrease, or set a preset volume with a single key press. Long-press (hold 0.5 s) to jump directly to the preset volume.

<!-- TODO: Screenshot of the three Volume Key variants (up / down / preset) -->
<!-- ![Volume Keys](docs/images/action-key-volume.png) -->

**Settings:**
| Option | Description |
|--------|-------------|
| Device | Which Sonos speaker to control |
| Command | `Volume Up`, `Volume Down`, or `Set Preset` |
| Preset volume | Target volume for long-press or preset command |
| Show volume | Display the current volume on the key |

---

### Playback Control Key

Next track, previous track, shuffle, or repeat — each as a dedicated key.

Skip buttons automatically **dim** when a radio station is playing (since skipping is not available for radio streams).

<!-- TODO: Screenshot showing next/previous/shuffle/repeat keys, dim skip buttons on radio -->
<!-- ![Playback Control Keys](docs/images/action-playback-control.png) -->

**Settings:**
| Option | Description |
|--------|-------------|
| Device | Which Sonos speaker to control |
| Command | `Next`, `Previous`, `Shuffle`, or `Repeat` |

---

### Play Favorite

Play one of your saved Sonos favorites with a single key press.

<!-- TODO: Screenshot of the Play Favorite key with cover art -->
<!-- ![Play Favorite](docs/images/action-play-favorite.png) -->

**Settings:**
| Option | Description |
|--------|-------------|
| Device | Which Sonos speaker to control |
| Favorite | Select from your Sonos favorites list |

---

## Setup

1. Install the plugin via the Elgato Marketplace or by double-clicking the `.streamDeckPlugin` file.
2. Drag an action from the **Sonos Controller** category onto a key or dial slot.
3. Open the action's settings (click the key in Stream Deck software).
4. Select your **Sonos device** from the dropdown — devices are discovered automatically.
5. Configure the remaining options and click anywhere to save.

**First use:** The plugin discovers Sonos speakers on your network when it loads. If your speaker does not appear in the list, ensure it is powered on and connected to the same network as your computer.

---

## Troubleshooting

### Speaker not showing in device list

- Ensure the Sonos speaker is on and connected to your Wi-Fi or Ethernet.
- The computer and speaker must be on the **same subnet** — the plugin uses UPnP, which does not cross router boundaries.
- Restart the Stream Deck software and wait a few seconds for discovery to complete.

### Cover art not showing on radio stations

Radio station logos are fetched from the Sonos device using the stream URI. This may take a moment on the first load after the plugin starts.

### Volume or mute key not responding

The plugin uses Sonos UPnP event subscriptions to stay in sync. If your network is unstable, subscriptions may occasionally fail and recover automatically within 60 seconds. Check the plugin log at:

```
<sonos-controller-install-dir>/logs/de.boriskemper.sonos-controller.0.log
```

### Track Dial shows "Sonos / Ready" instead of current track

This appears when no track info is available (e.g., the speaker is idle). Start playback on the speaker and the display will update automatically.

---

## Network Notes

- The plugin subscribes to **UPnP events** from each Sonos device to receive real-time updates.
- Subscriptions are automatically renewed to maintain the connection.
- The plugin only initiates outbound HTTP connections to Sonos devices on your local network — no cloud or external services are contacted.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

Built with:
- [Elgato Stream Deck SDK](https://developer.elgato.com/documentation/stream-deck/) (`@elgato/streamdeck`)
- [Sonos TypeScript SDK](https://github.com/svrooij/node-sonos-ts) (`@svrooij/sonos`) by Stephan van Rooij
- [Material Design Icons](https://pictogrammers.com/library/mdi/) (`@mdi/js`) — MIT license
