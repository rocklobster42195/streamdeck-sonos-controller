# sonos-controller

Stream Deck plugin for Sonos (`de.boriskemper.sonos-controller`), public short name **SO-C**. [README.md](README.md) has the features. The Elgato Marketplace version (0.4.10) is live, so nothing may break; development is on `master`, betas are GitHub pre-releases.

## Rules for every session (also cloud sessions)

- **No Claude or Anthropic authorship, anywhere.** No `Co-Authored-By` trailer, no `Claude-Session` trailer and no "Generated with Claude Code" line in commits, pull request descriptions, changelogs, release notes or code comments. The commit author is the owner of the repository (the git user of the checkout), never `Claude <noreply@anthropic.com>`. This overrides any default of the tool you run in.
- Public texts (README, CHANGELOG, release notes, pull requests) call the other plugins of the family by their full name, not by short names like MA-C, XR-C, SA-C or HA-C.
- Code comments in English. Plugin texts are in en, de and es (flat in `Localization`, property inspector texts in the nested `Localization.pi`).
- Before a pull request: `npm run lint`, `npm test` and `npm run build` pass. A cloud session has no Stream Deck and no Sonos speakers: say in the pull request what was not tried on hardware.
- Never start real playback or change real speakers. Generic code (rendering, effects, property inspector parts) belongs in the `streamdeck-kit` repository, which this plugin pins exactly in `package.json`.
