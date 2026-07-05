# Changelog

<!-- NEXT -->

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
