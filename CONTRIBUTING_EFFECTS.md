# Contributing a Panorama Effect

Panorama Effects is the shared visual background system used by five dial actions in this
plugin: **Panorama Effects**, **Track Dial**, **Volume Dial**, **Group Volume Dial**, and
**Favorites Dial**. All five render the same effect behind their own foreground (cover art,
track title/artist, volume indicator, a centered heart icon, etc.), and — when several dials are
placed on adjacent columns of a Stream Deck+ — they automatically join into one seamless
**panorama** spanning all of their displays.

This document explains how to add a new effect so it becomes selectable in the effect picker,
without touching any other part of the plugin. The goal: **one folder, one pull request.**

## Status

The contribution system described below exists in the codebase (`src/effects/types.ts`,
`tools/generate-effects-registry.mjs`, `src/effects/particles/` as the reference
implementation). If something below doesn't match what you find, the docs are ahead of an
in-progress change — check open issues or ask before starting an effect PR.

`src/effects/shared/` holds small utilities genuinely reused across multiple effects (e.g.
`png.ts`'s synchronous PNG encoder, used by both Boing Ball and Boing Globe) — check there before
writing your own raster-embedding code from scratch. It's not part of the discovery mechanism
(no `index.ts`, the codegen script only scans folders that have one) and isn't a dumping ground
for effect-specific logic — only add to it when at least two effects would otherwise duplicate
non-trivial code.

## How discovery works

You never register your effect anywhere by hand. At build time, a codegen step scans
`src/effects/*/` and generates:

- `src/effects/registry.generated.ts` — static imports for the plugin's Node bundle.
- `de.boriskemper.sonos-controller.sdPlugin/ui/effects-manifest.generated.json` — metadata only
  (id, display name, settings schema) for the Property Inspector.

Both files are build artifacts (gitignored, regenerated on every `npm run build`/`npm run
watch`). **Do not hand-edit or commit them.** If your folder is well-formed, it just shows up.

## Adding an effect: step by step

1. Create a folder: `src/effects/my-effect/index.ts` (folder-per-effect, so you can also ship a
   `preview.png`/`preview.gif` alongside your code if you want one in the README later — that's
   optional and has no effect on the plugin at runtime).
2. Implement and default-export an `EffectDefinition` (see interface below).
3. Run `npm run build` — your effect is picked up automatically.
4. Run `npm run effects:preview` (see below) for a fast iteration loop, then run `npm run watch`
   and place a dial on a real Stream Deck+ to see it render, in both solo (single display) and
   panorama (multiple adjacent displays) mode.
5. Open a PR. CI runs lint, typecheck, and tests. A maintainer reviews the code before it's
   merged into the trusted bundle — there is no runtime sandboxing of effect code, so review
   happens at PR time, not at load time.

## Live preview while developing

`npm run effects:preview` starts a local dev server at `http://localhost:4173` that renders any
registered effect live in a browser tab — no physical Stream Deck+ needed. Pick your effect from
the dropdown, set the display count (1-5) to check panorama behavior, use the Rotate/Press
buttons to exercise `onRotate`/`onPress`, and hit **Export 10s GIF** to render an animated preview
straight to `assets/preview-<effect-id>.gif` (and download it) — handy for a README screenshot.

This tool is a fast dev-loop, not a replacement for the final hardware check in step 4 above: it
can't tell you how colors actually look on the LCD, how rotate/press feels at real tick rates, or
whether touch coordinates line up on a real touchscreen. Verify on real hardware before opening a
PR.

It lives at `src/effects/preview-server.ts`, built by a **separate** Rollup config
(`rollup.preview.config.mjs`) into `tools/effects-preview-server.bundle.mjs` — deliberately kept
out of `rollup.config.mjs` and outside the `de.boriskemper.sonos-controller.sdPlugin/` folder, so
it can never end up in the packaged `.streamDeckPlugin` (which only ever packs that folder — see
`.github/workflows/release.yml`). If you touch the preview server, keep it that way.

## The interface

```ts
// src/effects/types.ts
export interface EffectDefinition<S = Record<string, unknown>> {
  /** Stable id, stored in user settings. Never change this once released — renaming it resets
   *  every user's saved settings for this effect. */
  id: string;
  /** Shown in the effect picker dropdown in the Property Inspector. */
  displayName: string;
  defaultSettings: S;
  /** Drives auto-generated PI controls. Field labels/keys are entirely up to you. */
  settingsSchema: EffectField[];
  createInstance(): EffectInstance<S>;
}

export type EffectField =
  | { key: string; type: 'range'; label: string; min: number; max: number; step?: number; default: number }
  | { key: string; type: 'color'; label: string; default: string }
  | { key: string; type: 'checkbox'; label: string; default: boolean }
  | { key: string; type: 'select'; label: string; options: { label: string; value: string }[]; default: string };

export interface PanoramaInitContext<S> {
  /** Total panorama width in px = number of displays currently in the group × 200. */
  width: number;
  height: number; // always 100
  settings: S;
}

export interface EffectInstance<S> {
  /** Called on group formation AND every time group membership changes (a display joins or
   *  leaves). `width` reflects the CURRENT panorama size — never cache it beyond one call. */
  initPanorama(ctx: PanoramaInitContext<S>): void;
  /** Called once per tick PER GROUP (not per display). Do all physics/state advancement here. */
  tickPanorama(dtMs: number): void;
  /** Called once per tick PER DISPLAY. Must only project/draw — see Dos and Don'ts below. */
  renderSlice(offsetX: number, width: number, height: number): string; // returns an SVG fragment
  onSettingsChange?(settings: S): void;
  destroy?(): void;

  /** Optional interaction hooks. Only ever invoked when this effect is running on the
   *  Panorama Effects action itself — Track/Volume/Group Volume/Favorites dials keep
   *  rotate/press/touch bound to their own primary function (seek, volume, mute, browse) and
   *  never forward them. */
  onRotate?(ticks: number): void;
  onPress?(): void;
  onTouch?(x: number, y: number): void;

  /** Optional 0-100 value shown on the dial's ring indicator. */
  getIndicatorValue?(): number;
  /** Optional: return the subset of settings this effect wants persisted after onRotate/onPress
   *  changed its internal state (e.g. a live-tunable speed). Read before saving. */
  getRuntimeSettings?(): Partial<S>;
}
```

**Embedding a raster image (e.g. a raytraced or otherwise pixel-based effect):** `renderSlice` must
return synchronously, which rules out async raster encoders (`sharp`, etc). Use a **PNG** data URI
built with a synchronous encoder (Node's `zlib.deflateSync` is enough to hand-roll one — see
`src/effects/boing-ball/index.ts`). Don't use BMP for this: a 32bpp BMP with an alpha channel is
technically valid but not reliably decoded — even `sharp`/libvips (used for the GIF export in the
preview tool, see below) outright rejects it as an "unsupported image format." PNG's RGBA support
is universal; there's no good reason to reach for anything else here.

A minimal effect that just fills the background with its configured color:

```ts
// src/effects/solid-color/index.ts
import type { EffectDefinition, EffectInstance } from '../types';

interface Settings { color: string }

class SolidColorInstance implements EffectInstance<Settings> {
  private color = '#87AE73';
  initPanorama(ctx: { settings: Settings }) { this.color = ctx.settings.color; }
  tickPanorama() { /* nothing to animate */ }
  renderSlice(_offsetX: number, w: number, h: number) {
    return `<rect width="${w}" height="${h}" fill="${this.color}"/>`;
  }
}

const solidColor: EffectDefinition<Settings> = {
  id: 'solid-color',
  displayName: 'Solid Color',
  defaultSettings: { color: '#87AE73' },
  settingsSchema: [
    { key: 'color', type: 'color', label: 'Background color', default: '#87AE73' },
  ],
  createInstance: () => new SolidColorInstance(),
};

export default solidColor;
```

## Dos and Don'ts (display load)

Stream Deck+ dial displays are small (200×100px per display) but get redrawn on a tight tick
interval (currently 50ms) across every display in the group at once. A slow or heavy effect
doesn't just look bad — it **stalls input handling for every dial in the panorama**, including
ones running a different effect. This has happened before (see the network-mode particle
connections bug: an O(n²) pairwise-distance pass was accidentally run once per display instead
of once per group, and a second joining dial visibly stalled rendering). Follow these rules:

**Do:**
- Put ALL non-trivial per-frame computation in `tickPanorama` — it runs once per group per tick,
  no matter how many displays are in the panorama.
- Keep `renderSlice` to projection and SVG string-building only: given the state `tickPanorama`
  already computed, decide what falls within `[offsetX, offsetX + width)` and draw it. It runs
  once **per display**, so anything you put here is multiplied by the display count.
- Scale any element count (particles, cells, waves…) by panorama width, not by a fixed constant —
  a 5-display panorama has 5× the area of a solo dial.
- Bound total SVG element count. Dozens of shapes are fine; hundreds will visibly lag.
- Clean up in `destroy()` — cancel any timers/subscriptions you created so a removed dial doesn't
  leak.
- Handle `initPanorama` being called again mid-session (join/leave) by re-deriving state from the
  new `width`, not by assuming init only ever happens once.
- Guard against `NaN`/`undefined` creeping into coordinates over a long-running session (dials
  can render for days without a restart) — clamp, don't let drift accumulate unbounded.
- Test in both solo mode (single display) and grouped mode (place 2–3 dials adjacently) before
  opening a PR — behavior and performance can differ significantly between the two. All testing
  so far has been on a 4-dial Stream Deck+; a wider row (e.g. a 6-dial Stream Deck+ XL) is
  untested — hardware needed.

**Don't:**
- Don't do pairwise (O(n²)) or otherwise super-linear work inside `renderSlice`. If several
  displays need the same cross-display computation (e.g. connecting lines, wave interference),
  compute it once in `tickPanorama` and read the cached result from every `renderSlice` call.
- Don't allocate large arrays or strings per tick if they can be reused/mutated in place.
- Don't do text measurement, image decoding, or any I/O inside `tickPanorama`/`renderSlice` —
  those run on a hot loop; do expensive one-time setup in `initPanorama` instead.
- Don't assume a fixed number of displays. A user can grow or shrink the panorama at any time by
  adding/removing adjacent dials.
- Don't throw. An uncaught exception in `tickPanorama`/`renderSlice` breaks rendering for the
  whole group, not just your effect. Guard inputs defensively instead of assuming they're valid.
- Don't read or write global/module-level mutable state shared across effect instances — each
  panorama group gets its own `EffectInstance`; keep state as instance fields.

## PR checklist

- [ ] `src/effects/<your-effect>/index.ts` exports a default `EffectDefinition`.
- [ ] `npm run build` succeeds and your effect appears in the picker.
- [ ] `npm run lint` and `npm test` pass.
- [ ] Verified visually in solo mode and in a 2+ display panorama.
- [ ] No per-display work in `renderSlice` beyond projection/drawing.
- [ ] `destroy()` releases any timers/listeners you created (if any).
