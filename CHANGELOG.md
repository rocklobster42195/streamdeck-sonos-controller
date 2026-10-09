<!-- NEXT -->

- **Playback Control key: the family's key** (the same in Music Assistant Controller, from the kit): next, previous, shuffle, repeat for any player on the deck, and crossfade and "Don't stop the music" for Music Assistant's players. New look: "on" with a tinted plate and frame, "off" with its own icon (shuffle off, repeat off). Your keys keep their speaker, command and seek step; hold Next/Previous to seek as before.
- **New tracks show within 2 s** (title, cover, colour), also for Spotify and radio from the Sonos app: the speaker reports a new track 7–18 s late on its own, so SO-C now asks it every 2 s what plays (a tiny request over its local connection) and fetches the track as soon as it changed.
- **Play/Pause key: the family's key** (the same in Music Assistant Controller and System Audio Controller, from the kit). It controls any player on the deck: a Sonos room (grouped: its group), music on the PC, Music Assistant's players; without a chosen one the speaker that started playing last. Two icons at the top to choose: your own icon, the service it plays from (Spotify, TIDAL, …: its logo) or the battery. A press sends a clear play or pause and shows it at once. Your keys keep their speaker and look (the battery stays top right); the device name is now the key's Stream Deck title, so its size and colour are set in Stream Deck's title settings.
- Speakers on deckbus tell their group's members, the music service and, for a Roam or Move, the battery (`members`, `source`, `battery`), for the keys in every plugin.
- **Every Sonos group on deckbus**, not only the speakers SO-C's own actions use: keys that follow the active speaker see a radio started in the Sonos app at once (it came late, through Music Assistant), and a stopped one keeps showing what stopped.
- **Fixed: a dial in a shared Panorama stayed black** after its plugin (or another one in the row) restarted, until the plugin leading the row restarted too (kit 0.1.0-alpha.7).
- **Music Assistant on a Sonos speaker:** keys and dials show the track, cover and colour from Music Assistant Controller as soon as it plays (the speaker itself reports Music Assistant's tracks 20–40 s late). Play/pause, next and previous go to Music Assistant (Sonos' own commands could leave the speaker silent), and a paused Music Assistant stream keeps its dimmed cover and resumes.
- **Fixed: speakers staying "not playing"** (no cover, no Panorama) after a speaker was restarted and the group set up again.
- **Requires Stream Deck 7.1 or later** and runs on Node.js 24 (Node 20 is out of support), like the other Rocklobster plugins.
- **New settings panels** (the family's panel kit, as in Music Assistant Controller): shorter, with tiles and switches instead of dropdowns, in English, German and Spanish. The "Speaker not showing up?" field only appears while no speaker is chosen. Dials with a Panorama effect get a settings window for it ("More settings …").
- **One Panorama per row of dials:** a row has one effect with one set of settings, chosen in any dial's Panorama section; each dial has a tick whether it shows the effect. Your existing effects are taken over (the Panorama Effects dial's effect wins its row). **Changed:** two different effects side by side in one row become one effect for the row.
- **Favorites and Queue dials as a scrolling list:** entries stacked with the selected one in the middle, gliding one entry per click of the dial; what is playing in green with a small wave. The Queue dial rests on the playing track and follows it. New switch "Show covers".
- **Favorites dial when idle:** a card with what is playing and where it comes from (the favorite, or the playlist, album or station Sonos reports); when that isn't known (e.g. music from Music Assistant) the heart as before. Replaces the cover mosaic.
- **Volume as pie, ring or open ring** on the Volume and Group Volume dials and the Volume key (default: the pie as before). With the ring or the open ring, the dials can show an icon of your choice in the middle or in the opening (e.g. a sofa for the living room).
- **Panorama colour per row:** the Panorama section has a **Colour** for the whole row — **Cover** (the active speaker, or one speaker), **fixed** or the effect's own — instead of each dial colouring it. The Panorama Effects dial's "Colour without a speaker" is taken over into the row. Sonos Controller shares its speakers' cover colours on deckbus, so a row without any Sonos dial follows the cover too.
- **Works with other plugins (deckbus):** the Panorama spans the dials of other plugins in the same row (e.g. Music Assistant Controller); local only, see the README.
- **Keys in colour:** the Play/Pause, Playback Control, Volume and Multi-control (Line-In) keys have a **Colour**: **Grey** (as before, the default), **Cover** (the colour of what the speaker plays), **Like Panorama** (the row colour of this Stream Deck, so keys and dials match) or a **fixed** colour. "Off" states (shuffle off, muted) stay grey.
- **Seek with Next/Previous:** hold the key to switch it to seeking; every tap then jumps by 5, 10, 15 or 30 seconds (setting), quick taps add up to one jump (six taps of 10 s jump a minute at once). The key shows the jump and where the track is; it switches back by itself after 3 seconds, or when held again. Next/Previous now act on release.
- **Keys for other plugins' players:** the Play/Pause, Playback Control and Volume keys can also control **Active player** (the speaker that started playing last) or a player of another plugin, e.g. your TV's player in Music Assistant (with Music Assistant Controller running). **Active player, also apps** includes music on your computer (Spotify, a browser tab …, with System Audio Controller running), which can also be picked by name. Pick it in the key's speaker list, below the Sonos speakers; the list is then called **Device** instead of Sonos device.
- **When a call starts on this computer:** per speaker **Nothing**, **Pause** or **Lower** (to a quarter), in the settings window of the Play/Pause and Volume keys and the Volume dials (the same everywhere); afterwards it plays again and the volume comes back, unless you changed it. The call comes from System Audio Controller (Teams, Discord, Zoom …). Off by default.
- **Speakers as players on deckbus:** Sonos Controller shares its speakers with other plugins (title, cover, position, volume, what each can do) and carries out their commands (play/pause, next, seek, volume, shuffle, repeat …), on by default. Groups show up as one player ("Kitchen + 2").
- **Calmer equalizer** on the Track dial: each bar glides to a new height a few times a second instead of jumping on every frame.
- **Fixed: the Queue dial showing an old queue while Music Assistant plays:** Music Assistant can play its track through the position of an old Sonos queue; the dial listed that old queue (with a wrong track marked and no covers). It now shows only the Panorama effect then, as with Music Assistant's other streams.
- **Fixed: a bonded sub or surround counted as a speaker of its own** right after the speakers were found (e.g. in the speaker lists of the settings panels).
- Smoother scrolling text, more robust cover loading and the volume display come from the shared kit now.
- **Fixed: the deck lagging by seconds** (e.g. the Queue dial reacting late to turning) while covers were animated: covers were sent to Stream Deck at full size (up to 300 KB each) in every frame. They are now shrunk once to the size the keys and dials draw.

- Play/Pause key: when paused or stopped it now keeps showing the cover, dimmed, with a play symbol on top, instead of switching to a plain play icon (taken over from Music Assistant Controller). When there is nothing to resume (e.g. after Music Assistant stopped, which leaves the Sonos queue empty), it shows the plain play icon as before.
- **Fixed the plugin slowing down other Sonos apps while your PC is on a VPN** (e.g. UniFi Teleport) or on a different network than the speakers. It used to ask the speakers to send live updates to an address they couldn't reach, and the speakers then delivered updates to *every* app (Home Assistant, Music Assistant, …) 20–40 seconds late, sometimes not at all. The plugin now only subscribes with an address on the speakers' own network. Without one it relies on its regular polling, and it switches back to live updates when the network changes.

---

## [0.4.10] — 2026-09-04

- **Fixed playing favorites from TIDAL** (and other streaming services — Amazon Music, Apple Music, Deezer): playlist and album favorites previously failed to play, and radio-style favorites (e.g. an artist radio) could show an error and do nothing. Both are now fixed.
- Fixed favorites occasionally failing to play when the target speaker was grouped under a different room (this affected Spotify favorites too).
- The Play Favorite list now hides a couple of non-playable "browse category" entries Sonos sometimes adds to your favorites on its own (e.g. "Trending Now"), and also picks up radio stations saved to Sonos' separate "My Radio Stations" list.
- Reduced log noise for a speaker that's known to be offline.

---

## [0.4.9] — 2026-08-29

- Renamed to "SONOS Controller" — no functional changes from 0.4.8.

---

## [0.4.8] — 2026-08-29

- **Fixed the plugin latching onto the wrong Sonos system.** If your own speakers were briefly unreachable at startup (e.g. a coordinator asleep) and another Sonos household was visible on the network — over a VPN, a guest network, at a friend's place — the plugin could adopt *that* system instead: wrong favourites in the Favorites Dial, and the Group Volume Dial coming up blank. It now locks onto your household on first run and won't switch to a foreign one. To deliberately move it to a different system, enter a speaker IP from that system in a dial's manual-IP field.
- Offline speakers on the dials read better: a dial running a Panorama effect now keeps the effect visible with a clear "speaker offline" overlay instead of blanking, and a group whose speaker can't be found at startup is now correctly shown as unavailable rather than stuck at 0%.

---

## [0.4.7] — 2026-08-26

- docs: link the Elgato Marketplace listing in the README
- fix: GroupVolumeDial group display — live updates and correct counts around bonded stereo pairs

---

## [0.4.6] — 2026-08-18

- **Fixed a crash on startup** affecting the packaged plugin on some systems — a native dependency was never actually being included in the shipped package, so the plugin could fail to load at all depending on the machine. If v0.4.5 didn't run for you, this fixes it.
- Track Control Dial's cover art is now shown in full instead of being cropped, which was especially visible on non-square artwork (e.g. some internet radio stations' banner-style images)
- Slightly faster default animation speed for the Particles panorama effect

---

## [0.4.5] — 2026-08-17

- test: add targeted tests for PanoramaOrchestrator, SonosGroupController, SonosDeviceController
- refactor: extract ControllerLease, migrate 8 actions off hand-rolled controller lifecycle
- fix: solo Panorama dials never picked up cover-art dominantColor
- fix: log why a cached/manual discovery IP failed instead of swallowing it
- fix: reduce Panorama Effects background CPU usage
- docs: explain why the VLAN fallback works in Network Notes
- docs: document the manual speaker-IP fallback for VLAN setups
- feat: add manual speaker-IP fallback for SSDP-blocked networks (VLANs)
- docs: fill in two missing settings, correct install instructions

---

## [0.4.4] — 2026-07-18

- **Multi-Control key** — a new action for Line-In switching (with an optional fade) and a live Battery status display for portable speakers (Roam/Move)
- Previous now restarts the current track instead of skipping to the previous one when pressed within the first few seconds
- Much more resilient to flaky, sleeping, or briefly offline speakers: discovery now recovers on its own if it ever stops responding, unreachable speakers are detected faster and more reliably across every key and dial, and a speaker being asleep or in standby (e.g. a Roam saving battery) no longer wipes a saved Multi-Control setting or gets treated as permanently gone
- Fixed several cover-art and playback issues: Queue Dial occasionally showing the wrong track's art mid-change, a broken cover URL causing a fetch storm, and NAS/CIFS folder favorites failing to play
- Smoothed out group fade-out timing drift and fixed dial rotation being ignored while a fade was in progress
- Reduced a rare source of input lag from Stream Deck's own tile refreshes triggering unnecessary rebuilds behind the scenes

---

## [0.4.3] — 2026-07-15

- fix: Queue Dial panorama color race; hide progress bar for unknown duration
- fix: fake fade-out starting from 0 on the second+ fade
- feat: fake-smooth volume fade-out on Volume/Group Volume Dial and Volume Key
- Update CONTRIBUTING_EFFECTS.md with testing notes
- Update README with improved action descriptions
- docs: correct typo in Stream Deck+ XL description
- docs: fix empty 0.4.2 changelog entry

---

## [0.4.2] — 2026-07-14

- **Favorites Dial** can now show a Panorama effect background instead of the cover mosaic — a centered heart icon (filled while playing, outlined while paused), with a Left/Center/Right alignment setting
- **Play/Pause key**: optional progress bar at the bottom of the key, tinted to the cover's dominant color
- Panorama Effects Dial: title/artist text now truncates with an ellipsis instead of running off the group's edge, and crossfades smoothly on track change instead of snapping
- Fixed a bug where a track title containing `&` (or other XML-special characters) broke the Play/Pause key and Play Favorite key's cover art entirely
- Fixed the Panorama Effects Dial's track-info text disappearing when a non-Particles dial (Track/Volume/Group Volume/Favorites) sat at the right edge of a panorama group
- Cleaned up stray duplicate encoding markers in several Property Inspector files

---

## [0.4.0] — 2026-07-13

### New

- **Queue Dial** *(Stream Deck+)* — browse the current queue as a cover-art carousel, press to jump straight to a track, auto-return to now playing
- **Diagnostics Dial** *(Stream Deck+)* — live WiFi signal sparkline and connection details for the selected speaker
- **Fade out for favorites** — Play Favorite and Favorites Dial can fade the whole group down (2–8 s) before switching, then restore every speaker's own volume, so a line-out zone keeps its level and playlist changes never hard-cut
- **Battery indicator** — Track Dial and Play/Pause key can show a battery badge for portable speakers (Roam, Move): `Off`, `Warning`, or `Always`

### Improvements

- Covers now change practically in sync with the track: the next queue track's art is prefetched, and all cover fetches are deduplicated, throttled per speaker, and time-bounded
- Unreachable speakers show a clear speaker-off icon on every key and dial, retry their setup automatically, and fully recover the moment they're back online
- Panorama track text: the background pill behind the title is now sized with real font metrics instead of a rough estimate — no more oversized box sticking out left of long titles
- The plugin now unsubscribes cleanly from speaker events on shutdown, keeping event delivery fast across plugin restarts

### Fixes

- Grouped speakers: Next/Previous reliably target the group coordinator, and grouped members' covers no longer fail to load
- A failed device discovery at startup no longer breaks device lists and covers for the whole session — discovery retries until it succeeds
- Play/Pause key no longer defaults its cover art to hidden; Track Dial's full-bleed cover no longer squished

---

## [0.3.2] — 2026-07-10

### Panorama Effects

- Fixed picking a new effect on a solo dial (no adjacent same-effect neighbor) sometimes showing the wrong or previous effect instead of the one just selected
- Effect settings — density, speed, colors — are now configurable in the Property Inspector on **all four** dials (Volume, Track, Group Volume, Panorama Effects), not just Panorama Effects as before
- Effect setting changes (density/speed/colors) now apply immediately to an already-running effect instead of only on the next full restart
- Added a "Reset to defaults" button for effect settings
- Boing Ball / Boing Globe speed simplified to a clean 1–5 scale in the Property Inspector
- Fixed a settings-corruption bug that could make a Volume Dial revert to a "not configured" screen after changing effect settings

### Fixes

- Volume Dial / Group Volume Dial: the "Show text" checkbox now matches what's actually shown on a brand new tile
- The "not configured yet" hint now shows the dial's own name (e.g. "VOLUME", "TRACK") instead of a generic "SONOS" label
- Group Volume Dial: an unreachable group member no longer freezes volume changes for up to 30 seconds — now fails fast instead

---

## [0.3.1] — 2026-07-09

### Panorama Effects

- Fixed switching effects in the Property Inspector having no effect once a dial's panorama group was already running — the newly selected effect now actually starts
- Track info can now be shown with any effect, not just Panorama Particles
- Added a "Reset colors" button for Boing Ball

### Property Inspector

- Fixed several Property Inspector pages not reacting to setting changes after the initial load (relied on an event the underlying component library never fires)

---

## [0.3.0] — 2026-07-09

### Panorama Effects (new effects + community contributions)

- "Panorama Particles" is now **Panorama Effects** — a pluggable visual-effects layer with a selectable effect, no longer just particles
- Three new effects: **Boing Ball** (the classic raytraced checkered ball, bouncing across panels), **Boing Globe** (a spinning raytraced Earth drifting and wrapping seamlessly around panels), and **Matrix Rain** (cascading code rain, density adjustable by rotating)
- Any effect can now also be used as the **Background** on the Track Dial, Volume Dial, and Group Volume Dial — not just Particles as before
- A dial running an effect merges with an adjacent dial only if it's running the **same** effect; otherwise it renders solo — mixing different effects side by side is now possible
- Fixed a rendering desync where adjacent panels could briefly show different animation frames of the same shared effect
- Effects are sandboxed against crashing the plugin — a misbehaving effect now skips a frame instead of taking down every action
- The plugin is now open to **community-contributed effects** — see [CONTRIBUTING_EFFECTS.md](CONTRIBUTING_EFFECTS.md) for the effect interface and how to submit one

### Fixes

- The "not configured yet" hint shown on Track/Volume/Group Volume/Favorites dials before a device or group is selected was nearly invisible (very low contrast) — now shows a clearly visible gear icon
- Panorama Particles density tuned up slightly, and fixed a saved density/speed value from before range limits existed silently overriding the current defaults

---

## [0.2.7] — 2026-07-05

### Group Volume Dial (new)

- New dial action controlling the volume of an entire Sonos group (all speakers grouped together), following whichever group its selected device currently belongs to — even if membership or the coordinator changes later
- Rotating adjusts every group member by the same number of percentage points, preserving the balance between speakers (e.g. a Sonos Port already louder than its satellites stays proportionally louder instead of being flattened to match them)
- Long-touch saves each member's individual volume as a preset; tapping recalls it
- Mute affects the whole group with a single press
- Same pie-chart canvas, particle background, and alignment options as the regular Volume Dial

### Volume Dial

- Long-touch now saves the current volume as the new preset and updates the Property Inspector to match
- Volume percentage text can now be shown at every alignment, including centered — a translucent background chip keeps it legible over the pie or particle background
- Fixed rare cases where rotating or muting could feel delayed, or the dial's visual update could lag behind actual rotation

### Volume Key

- Mute now updates the icon immediately instead of waiting on the device's own feedback

### Reliability

- Fixed a background connection leak that could accumulate over a long session and gradually slow down volume/playback controls (affected the Volume Key, Play/Pause Toggle, and Playback Control actions)
- Fixed cover-art fetching retrying forever for tracks with no available artwork (e.g. some radio stations), which could flood logs and background network traffic over time
- Panorama particle backgrounds no longer redo their full connection-line computation once per display — noticeably reduces load when multiple particle-enabled dials share a panorama

### Track Dial

- Fixed dominant cover color being ignored, particle count/speed controls having no effect, and the dial incorrectly detecting itself as part of a panorama group when used standalone with a particle background

### Property Inspector

- Added missing `lang`/`viewport` meta tags to remaining Property Inspector pages
- Minor styling cleanup in the Favorites Dial's Property Inspector

---

## [0.2.6] — 2026-06-29

### Property Inspector

- Select dropdowns no longer appear white — vendored and patched `sdpi-components.js` to add `-webkit-appearance:none`
- Settings now apply reliably — switched from static to datasource-based `<sdpi-select>`; sdpi-components manages settings merging internally
- Dropdown labels are now localized via `en.json` / `de.json` / `es.json` instead of hardcoded inline strings

### Favorites Dial

- Browse → mosaic transition is now a smooth fade-through-black: browse view fades to black, then mosaic fades in — no more hard cut
- Touch-tap to return to now-playing also triggers the fade
- Rotating during a fade cancels it cleanly

### Panorama Particles

- Gradient overlay behind track info text for better legibility when text sits on a bright background

### Volume Dial

- Added option to hide volume number and device name text on the dial canvas

### Play / Pause Toggle

- Cover art no longer fails silently when Sonos returns an empty HTTP body — empty responses are now detected and skipped
- Responses with non-image MIME types are rejected cleanly

### Standby recovery

- Cover art is re-fetched during the background poll when missing, so the display recovers after a device wakes from standby
- Radio station logo is fetched via the Sonos `/getaa` endpoint as a fallback when `getCurrentTrack()` returns no metadata

---

## [0.2.0] — 2026-06-27

### Rocklobster

Full Sonos control for Elgato Stream Deck+. First public release.

**Actions**
- Play / Pause Key — cover art, scrolling track title, radio support
- Playback Control Key — next, previous, shuffle, repeat; all four dim for radio streams
- Volume Key — volume up / down / mute / preset
- Play Favorite Key — plays a saved Sonos favorite with one press
- Track Dial — LCD panel with cover art, scrolling title, progress bar, equalizer / particle visualizer
- Volume Dial — full-canvas pie chart, mute icon, alignment options, particle background
- Favorites Dial — browse and play Sonos favorites list, configurable return timeout
- Panorama Particles Dial — ambient particle animation spanning up to 4 LCD panels

**Notable fixes**
- Sonos Radio (Deezer-powered) correctly detected as radio — playback controls dim on load
- UPnP 402 error on radio favorite playback resolved
- Particle count and speed configurable per dial; controls hidden when part of a panorama group
- Slider inputs across all PIs now include a synced number field

---
