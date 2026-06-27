# Sonos Controller for Elgato Stream Deck

Full Sonos playback control for your Stream Deck — cover art, volume, track info, and more.

<!-- TODO: Banner screenshot of the plugin in action -->

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

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Show cover art | Display album art on the key while playing |
| Show track title | Scroll the track title and artist across the key |
| Font color | Color for the scrolling title text |
| Font size | Size of the title text (px) |

---

### Track Dial *(Stream Deck+ only)*

The centerpiece of the plugin. The LCD panel displays the album or station cover on the right, a scrolling track title, artist name, and a progress bar colored to match the cover art.

<!-- TODO: Screenshot of the Track Dial panel while playing (eq mode) -->
<!-- TODO: Screenshot of the Track Dial panel in particles mode -->
<!-- TODO: Screenshot of the Track Dial panel while paused (dimmed state) -->
<!-- TODO: Screenshot of a radio station with blurred logo backdrop -->

| Interaction | Effect |
|-------------|--------|
| Rotate | Seek ±5% in the current track |
| Press | Skip to next track |
| Touch | Toggle play / pause |

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Background | `None` (track info only), `Equalizer` (animated bars), or `Particles` (network particle animation) |
| Show track title | Display title and artist on the panel |
| Font color | Color for the title text |
| Font size | Size of the title text (px) |
| Marquee speed | Scroll speed for long titles |
| Marquee pause | How long to pause before scrolling begins |

---

### Volume Dial *(Stream Deck+ only)*

Dedicated volume control. Displays a pie chart showing the current volume level. When muted, the volume-off icon replaces the pie.

<!-- TODO: Screenshot of the Volume Dial (left alignment, ~60% volume) -->
<!-- TODO: Screenshot of the Volume Dial in muted state -->
<!-- TODO: Screenshot of the Volume Dial with particles background -->

| Interaction | Effect |
|-------------|--------|
| Rotate | Adjust volume (±1% per tick, ±2% for fast rotation) |
| Press | Toggle mute |
| Touch | Set volume to configured preset |

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Preset Volume | Target volume for touch |
| Alignment | Position of the pie: `Left`, `Center`, or `Right` |
| Background | `None` or `Particles` (network particle animation) |

---

### Favorites Dial *(Stream Deck+ only)*

Browse and play your saved Sonos favorites. Rotate to scroll through the list; the LCD shows the cover art and title of the currently highlighted favorite.

<!-- TODO: Screenshot of the Favorites Dial browsing the list -->

| Interaction | Effect |
|-------------|--------|
| Rotate | Browse favorites list |
| Press | Play the highlighted favorite |
| Touch | Return to now playing |

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |

---

### Panorama Particles Dial *(Stream Deck+ only)*

Ambient particle animation that spans multiple LCD panels side by side as one continuous scene. Place two or more of these dials in adjacent slots to connect them into a single panoramic display.

<!-- TODO: Screenshot of 2–4 Panorama Particles dials connected as one scene -->

| Interaction | Effect |
|-------------|--------|
| Rotate | Adjust particle count |
| Press | Reset particle count |

| Setting | Description |
|---------|-------------|
| Column | Which column this dial occupies in the panorama (0 = leftmost) |

---

### Volume Key

Increase, decrease, or set a preset volume with a single key press.

<!-- TODO: Screenshot of the three Volume Key variants (up / down / preset) -->

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Command | `Volume Up`, `Volume Down`, `Mute`, or `Set Preset` |
| Preset volume | Target volume for the preset command |

---

### Playback Control Key

Next track, previous track, shuffle, or repeat — each as a dedicated key. All four buttons **dim** when a radio station is playing, since playback controls are unavailable for radio streams.

<!-- TODO: Screenshot showing next/previous/shuffle/repeat keys -->
<!-- TODO: Screenshot showing all four keys dimmed while radio is playing -->

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Command | `Next`, `Previous`, `Shuffle`, or `Repeat` |

---

### Play Favorite

Play one of your saved Sonos favorites with a single key press.

<!-- TODO: Screenshot of the Play Favorite key with cover art -->

| Setting | Description |
|---------|-------------|
| Device | Which Sonos speaker to control |
| Favorite | Select from your Sonos favorites list |

---

## Setup

1. Install the plugin via the Elgato Marketplace or by double-clicking the `.streamDeckPlugin` file.
2. Drag an action from the **Sonos Controller** category onto a key or dial slot.
3. Open the action's settings (click the key in Stream Deck software).
4. Select your **Sonos device** from the dropdown — devices are discovered automatically on your local network.
5. Configure the remaining options and click anywhere to save.

---

## Troubleshooting

### Speaker not showing in device list

- Ensure the Sonos speaker is on and connected to your Wi-Fi or Ethernet.
- The computer and speaker must be on the **same subnet** — the plugin uses UPnP, which does not cross router boundaries.
- Restart the Stream Deck software and wait a few seconds for discovery to complete.

### Cover art not showing on radio stations

Radio station logos are fetched from the Sonos device using the stream URI. This may take a moment on the first load after the plugin starts.

### Controls not responding

The plugin uses Sonos UPnP event subscriptions to stay in sync. If your network is unstable, subscriptions may occasionally fail and recover automatically within 60 seconds.

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
