import type { EffectDefinition, EffectInstance, PanoramaInitContext } from "../types";
import { encodePngDataUri } from "../shared/png";

// Classic "digital rain" look, panorama-width-aware. Toned down deliberately: this runs behind
// cover art/text/etc, so it needs to read as a "dezent" (subtle) background pattern, not a neon,
// screen-filling effect.
//
// Ported from the well-known canvas reference technique (see e.g.
// https://thecodeplayer.com/walkthrough/matrix-rain-animation-html5-canvas-javascript), NOT a
// from-scratch per-stream distance/brightness model (an earlier draft computed brightness as a
// function of distance-to-head with an explicit trailLen per stream — it looked like short,
// same-length blips, not the long, organically-varied, flickering streaks in reference images).
// The actual trick: keep ONE persistent RGBA framebuffer for the whole panorama width, fade it
// toward black by a constant factor every tick (this alone produces long trails — the fade factor
// controls how many ticks it takes to reach black, not any per-stream state), and draw a FRESH
// random glyph in a bright highlight color at each active column's current head row every tick a
// column is active. Multiplying RGB by a constant preserves hue while lowering magnitude, so a
// green cell fades through darker green to black — matches "verglühen" (burning out) instead of
// drifting through gray. Redrawing a new random glyph each time the head dwells on/passes a row
// (rather than a fixed character per cell) is what gives the constant flicker in real "digital
// rain" — a fixed-per-cell approach read as static, not alive. Apparent length/speed variety is
// entirely a side effect of independent per-column spawn timing and per-column speed, not
// per-stream bookkeeping — much simpler and closer to the reference behavior.
//
// Rendered as ONE embedded PNG raster per display (see ../shared/png.ts), not per-character SVG
// <text> elements: CONTRIBUTING_EFFECTS.md's Dos/Don'ts is explicit that "hundreds [of SVG
// elements] will visibly lag" — an earlier draft emitted one <text> per lit cell (hundreds/frame)
// and stalled the Stream Deck app badly enough to force a plugin restart. Cropping the persistent
// framebuffer into a single raster per renderSlice call is also cheaper: no per-frame brightness
// recomputation needed at all, tickPanorama already leaves the pixels in their final state.

export interface MatrixRainEffectSettings {
    color?: string; // base/head tint the whole ramp is derived from
    savedDensity?: number; // target fraction of columns concurrently raining — live-tunable via onRotate
}

const CW = 4, CH = 6; // LCD px per glyph cell
const CELL_BITS = CW * CH; // 24 — fits comfortably in a 32-bit int mask
const GLYPH_FILL_PROB = 0.55;

// Per-tick multiplicative fade — this alone determines trail length. Trail length in ROWS is
// speed * (ticks to fade to invisible), so this must scale with the speed range in newDrop(). At
// the ~0.16 rows/tick mid-speed, 0.96 takes ~55 ticks to fade to ~10% brightness, covering ~9
// rows — a bit over half a solo display's height. (0.978 was tried first and read as "too long".)
const FADE_FACTOR = 0.96;
const SPAWN_CHANCE_PER_TICK = 0.01; // per idle column, per tick, while under the density target — halved, read as too bursty

const DENSITY_DEFAULT = 0.5; // target fraction of columns raining at once (as a multiplier, see below) — halved, read as too many concurrent streaks
const DENSITY_MIN = 0.15;
const DENSITY_MAX = 1.5;
const DENSITY_STEP = 0.1; // halved — the dial felt too sensitive per detent

// Accepts both "#RRGGBB" (the PI color picker) and "rgb(r,g,b)" (getDominantColor()'s output,
// pushed through the same generic onSettingsChange({color}) pipeline every effect shares) —
// Particles never needed this because it hands the color string straight through as an SVG `fill`
// attribute (both formats are valid CSS there); this is the first effect that decomposes color
// into numeric channels, so it's the first to actually need both formats parsed.
function parseColor(input: string): [number, number, number] {
    const rgbMatch = input.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    const h = input.replace('#', '');
    return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

interface Drop {
    active: boolean;
    row: number; // fractional row position of the head
    speed: number; // rows/tick
}

function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

let instanceCounter = 0;

class MatrixRainEffectInstance implements EffectInstance<MatrixRainEffectSettings> {
    private readonly rand = rng(0x4d415458 + (++instanceCounter));

    private width = 200;
    private height = 100;
    private totalCols = 50;
    private rows = Math.floor(100 / CH);
    private density = DENSITY_DEFAULT;
    private drops: Drop[] = [];
    private frame: Uint8ClampedArray = new Uint8ClampedArray(0); // persistent panorama-wide RGBA buffer

    // The configurable/dominant-color tint. Only this is stored — the bright "head" color is
    // derived from it at draw time (see headColor()), so a runtime color change (e.g. dominant
    // color from newly playing cover art, pushed via onSettingsChange) naturally only affects
    // glyphs drawn from that point on: already-baked pixels in `frame` keep whatever color they
    // were drawn with and just fade in place, never get recolored retroactively.
    private baseRgb: [number, number, number] = parseColor('#22C55E');

    initPanorama(ctx: PanoramaInitContext<MatrixRainEffectSettings>): void {
        const firstInit = this.drops.length === 0;
        if (ctx.settings.color) this.baseRgb = parseColor(ctx.settings.color);
        if (firstInit) this.density = ctx.settings.savedDensity ?? DENSITY_DEFAULT;

        const newTotalCols = Math.max(1, Math.floor(ctx.width / CW));
        if (ctx.width !== this.width || ctx.height !== this.height || firstInit) {
            this.width = ctx.width;
            this.height = ctx.height;
            this.rows = Math.max(1, Math.floor(ctx.height / CH));
            this.totalCols = newTotalCols;
            this.frame = new Uint8ClampedArray(this.width * this.height * 4);
            this.respawnAllDrops();
        }
    }

    private newDrop(): Drop {
        return {
            active: true,
            row: -this.rand() * 4,
            // Wide spread (~7x, slow crawl to brisk fall) so columns visibly race each other
            // instead of all drifting at nearly the same rate. Halved from the first tuning pass
            // — the original range read as too fast for a "dezent" ambient background.
            speed: 0.04 + this.rand() * 0.28,
        };
    }

    // Bright flash color for a freshly-drawn glyph, derived from the current baseRgb rather than a
    // fixed color — this is the only place the head color is computed, so it always reflects
    // whatever baseRgb is *right now* without touching already-drawn pixels. First version mixed
    // 65% toward white, which read as "dominant color too washed out, head not bright enough" —
    // both are fixed by boosting brightness while preserving hue (scale toward the channel max
    // instead of toward white) and only a small white flash on top, rather than relying on a
    // heavy white mix to read as "bright".
    private headColor(): [number, number, number] {
        const b = this.baseRgb;
        const boosted: [number, number, number] = [
            Math.min(255, b[0] * 1.6),
            Math.min(255, b[1] * 1.6),
            Math.min(255, b[2] * 1.6),
        ];
        const flash = 0.2;
        return [
            boosted[0] + (255 - boosted[0]) * flash,
            boosted[1] + (255 - boosted[1]) * flash,
            boosted[2] + (255 - boosted[2]) * flash,
        ];
    }

    private respawnAllDrops(): void {
        this.drops = Array.from({ length: this.totalCols }, () => {
            // Only start a fraction active immediately (matching density) — the rest spawn in
            // gradually over the next several ticks via the same per-tick chance tickPanorama
            // uses, so a restart doesn't look like a synchronized burst.
            const d = this.newDrop();
            d.active = this.rand() < this.density;
            if (d.active) d.row = this.rand() * this.rows - this.rows * 0.5;
            return d;
        });
    }

    // Draws one fresh random glyph, in the given color, at (col, row) directly into the
    // persistent frame. Off pixels are left untouched (they keep fading from whatever was there).
    private drawGlyph(col: number, row: number, color: [number, number, number]): void {
        const baseY = row * CH;
        if (baseY + CH <= 0 || baseY >= this.height) return;
        const baseX = col * CW;
        for (let bit = 0; bit < CELL_BITS; bit++) {
            if (this.rand() >= GLYPH_FILL_PROB) continue;
            const x = baseX + (bit % CW);
            const y = baseY + Math.floor(bit / CW);
            if (x < 0 || x >= this.width || y < 0 || y >= this.height) continue;
            const idx = (y * this.width + x) * 4;
            this.frame[idx] = color[0];
            this.frame[idx + 1] = color[1];
            this.frame[idx + 2] = color[2];
            this.frame[idx + 3] = 255;
        }
    }

    tickPanorama(): void {
        // Fading the WHOLE persistent buffer toward black is the entire trail mechanism — no
        // per-stream trail-length bookkeeping needed. Multiplying every channel by the same
        // factor preserves hue, so a lit green cell fades through darker green to black.
        for (let i = 0; i < this.frame.length; i += 4) {
            this.frame[i] *= FADE_FACTOR;
            this.frame[i + 1] *= FADE_FACTOR;
            this.frame[i + 2] *= FADE_FACTOR;
        }

        const targetActive = Math.round(this.totalCols * this.density);
        let activeCount = 0;
        for (const d of this.drops) if (d.active) activeCount++;
        const headColor = this.headColor();

        for (let col = 0; col < this.drops.length; col++) {
            const d = this.drops[col];
            if (!d.active) {
                if (activeCount < targetActive && this.rand() < SPAWN_CHANCE_PER_TICK) {
                    d.active = true;
                    d.row = -this.rand() * 4;
                    d.speed = 0.04 + this.rand() * 0.28;
                    activeCount++;
                }
                continue;
            }
            this.drawGlyph(col, Math.floor(d.row), headColor);
            d.row += d.speed;
            if (d.row > this.rows + 4) d.active = false;
        }
    }

    renderSlice(offsetX: number, width: number, height: number): string {
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height && y < this.height; y++) {
            for (let x = 0; x < width; x++) {
                const srcX = offsetX + x;
                if (srcX < 0 || srcX >= this.width) continue;
                const srcIdx = (y * this.width + srcX) * 4;
                const dstIdx = (y * width + x) * 4;
                rgba[dstIdx] = this.frame[srcIdx];
                rgba[dstIdx + 1] = this.frame[srcIdx + 1];
                rgba[dstIdx + 2] = this.frame[srcIdx + 2];
                rgba[dstIdx + 3] = 255;
            }
        }
        return `<image x="0" y="0" width="${width}" height="${height}" href="${encodePngDataUri(width, height, rgba)}"/>`;
    }

    onSettingsChange(settings: MatrixRainEffectSettings): void {
        if (settings.color) this.baseRgb = parseColor(settings.color);
    }

    // Controls the target fraction of columns raining at once, per spec.
    onRotate(ticks: number): void {
        this.density = Math.max(DENSITY_MIN, Math.min(DENSITY_MAX, this.density + ticks * DENSITY_STEP));
    }

    // A poke — instantly restart the whole rain (fresh spawn distribution).
    onPress(): void {
        this.respawnAllDrops();
    }

    getIndicatorValue(): number {
        return Math.round((this.density - DENSITY_MIN) / (DENSITY_MAX - DENSITY_MIN) * 100);
    }

    getRuntimeSettings(): Partial<MatrixRainEffectSettings> {
        return { savedDensity: this.density };
    }
}

const matrixRainEffect: EffectDefinition<MatrixRainEffectSettings> = {
    id: 'matrix-rain',
    displayName: 'Matrix Rain',
    defaultSettings: { color: '#22C55E' },
    settingsSchema: [
        { key: 'color', type: 'color', label: 'Color', default: '#22C55E' },
    ],
    createInstance: () => new MatrixRainEffectInstance(),
};

export default matrixRainEffect;
