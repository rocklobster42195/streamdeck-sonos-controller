# Changelog

<!-- NEXT -->

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
