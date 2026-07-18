import zlib from "node:zlib";
import type { EffectDefinition, EffectInstance, PanoramaInitContext } from "../types";
import { encodePngDataUri } from "../shared/png";
import { BM_W, BM_H, LAND_BITMAP_B64 } from "./landBitmap";

// A raytraced Earth globe with the same bounce physics as Boing Ball, but drifting off one edge
// of the panorama (no wall-bounce/direction-reversal) and reappearing fully offscreen on the
// other side — never visible on both edges at once — while spinning at a constant rate (real
// Earth rotation direction, independent of horizontal drift). Land/ocean data is a
// precomputed bitmap (see landBitmap.ts / tools/generate-globe-bitmap.mjs) — no geo libraries in
// the shipped bundle, just zlib.inflateSync + a bit-unpack.

export interface BoingGlobeEffectSettings {
    landColor?: string;
    oceanColor?: string;
    savedSpeed?: number; // px/tick horizontal drift — live-tunable via onRotate
}

// Same vertical bounce arc as Boing Ball (see src/effects/boing-ball/index.ts) — identical
// closed-form parabola, tuned there from local/tools/generate-boing-gif.mjs.
const FRAMES_HALF = 19;
const GRAVITY = 0.13;
const TILT_X = 23 * Math.PI / 180; // Earth's real axial tilt
const SPIN_STEP = Math.PI / (FRAMES_HALF * 2); // constant rate, direction-independent (no wall bounce to sync to)
const SPEC_POWER_LAND = 22, SPEC_POWER_OCEAN = 55;
// Flatter/more grazing than Boing Ball's LIGHT ([0.5, 0.85, 0.7]) — low Z so the terminator
// crosses through the CENTER of the visible disc, not just a sliver near the rim (a less
// grazing angle made the transition read as "too flat" — barely visible). Overall darkness is
// controlled separately via the ambient floor below, not by pulling the light angle back toward
// Boing Ball's, so this can stay flat without also going dark.
const LIGHT = norm3([0.7, 0.45, 0.45]);

const BOUNCES_PER_PANEL = 3;
const SPEED_DEFAULT = 200 / (FRAMES_HALF * 2 * BOUNCES_PER_PANEL);
const SPEED_MIN = SPEED_DEFAULT * 0.4;
const SPEED_MAX = SPEED_DEFAULT * 3;
const SPEED_STEP = SPEED_DEFAULT * 0.15;

function dot3(a: number[], b: number[]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm3(v: number[]): [number, number, number] {
    const l = Math.sqrt(dot3(v, v));
    return [v[0] / l, v[1] / l, v[2] / l];
}
function rotY(v: number[], a: number): [number, number, number] {
    const c = Math.cos(a), s = Math.sin(a);
    return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}
function rotX(v: number[], a: number): [number, number, number] {
    const c = Math.cos(a), s = Math.sin(a);
    return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

// Blends the day/night terminator over a band instead of a hard cutoff at dot(N,LIGHT)=0 — a
// plain Math.max(0, Nd) clamp has a visible kink exactly at the terminator, which at this small a
// render size (~56px sphere) looked like a stray hard-edged line across the ocean rather than a
// "dezent" (subtle) transition, especially noticeable in the Pacific.
const TERMINATOR_SOFTNESS = 0.07;
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function hexToRgb01(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [parseInt(h.substring(0, 2), 16) / 255, parseInt(h.substring(2, 4), 16) / 255, parseInt(h.substring(4, 6), 16) / 255];
}

// Decoded once, shared by every instance — the bitmap is universal, never per-instance.
let landBitmap: Uint8Array | undefined;
function getLandBitmap(): Uint8Array {
    if (landBitmap) return landBitmap;
    const compressed = new Uint8Array(Buffer.from(LAND_BITMAP_B64, 'base64'));
    const decoded = zlib.inflateSync(compressed);
    landBitmap = new Uint8Array(decoded);
    return landBitmap;
}
function isLand(bitmap: Uint8Array, bx: number, by: number): boolean {
    const i = by * BM_W + bx;
    return ((bitmap[i >> 3] >> (i & 7)) & 1) === 1;
}

let instanceCounter = 0;

class BoingGlobeEffectInstance implements EffectInstance<BoingGlobeEffectSettings> {
    private readonly id = ++instanceCounter;

    private initialized = false;
    private width = 200;
    private height = 100;
    private radius = 28;

    private x = 100; // virtual position across the whole panorama, wraps via modulo
    private vx = SPEED_DEFAULT;
    private bouncePhase = 0;
    private spin = 0;

    private landRgb: [number, number, number] = hexToRgb01('#87AE73'); // sage
    private oceanRgb: [number, number, number] = hexToRgb01('#1C3E6C'); // dark ocean blue

    initPanorama(ctx: PanoramaInitContext<BoingGlobeEffectSettings>): void {
        const firstInit = !this.initialized;
        this.initialized = true;
        this.width = ctx.width;
        this.height = ctx.height;
        this.radius = ctx.height * 0.28;
        if (ctx.settings.landColor) this.landRgb = hexToRgb01(ctx.settings.landColor);
        if (ctx.settings.oceanColor) this.oceanRgb = hexToRgb01(ctx.settings.oceanColor);

        if (firstInit) {
            this.vx = ctx.settings.savedSpeed ?? SPEED_DEFAULT;
            this.x = ctx.width / 2;
        } else {
            // Membership changed — keep position valid mod the new (possibly smaller) width,
            // over the extended range (including the fully-offscreen margins either side).
            const span = this.width + 2 * this.radius;
            this.x = (((this.x + this.radius) % span + span) % span) - this.radius;
        }
    }

    private floorY(): number { return this.height - 1 - this.radius; }
    private peakAmplitude(): number { return 0.5 * GRAVITY * FRAMES_HALF * FRAMES_HALF; }

    tickPanorama(): void {
        this.bouncePhase = (this.bouncePhase + 1) % (FRAMES_HALF * 2);
        this.x += this.vx;
        // Reset only once fully past the far edge, and reappear fully past the near edge — the
        // globe is never visible on both sides at once (unlike a plain modulo wrap, which shows
        // it exiting one edge and entering the other in the same frame).
        if (this.vx >= 0 && this.x - this.radius > this.width) {
            this.x = -this.radius;
        } else if (this.vx < 0 && this.x + this.radius < 0) {
            this.x = this.width + this.radius;
        }
        this.spin += SPIN_STEP;
    }

    private globeY(): number {
        const th = this.bouncePhase <= FRAMES_HALF ? this.bouncePhase : FRAMES_HALF * 2 - this.bouncePhase;
        return (this.floorY() - this.peakAmplitude()) + 0.5 * GRAVITY * th * th;
    }

    private renderGlobeAt(localX: number, y: number): string {
        const r = this.radius;
        const size = Math.ceil(r * 2) + 2;
        const rgba = new Uint8ClampedArray(size * size * 4);
        const bitmap = getLandBitmap();

        for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
                const idx = (py * size + px) * 4;
                const dx = px - size / 2;
                const dy = py - size / 2;
                const d2 = dx * dx + dy * dy;
                if (d2 >= r * r) { rgba[idx + 3] = 0; continue; }

                const dz = Math.sqrt(r * r - d2);
                const N: [number, number, number] = [dx / r, -dy / r, dz / r];
                let Nm = rotY(N, -this.spin);
                Nm = rotX(Nm, -TILT_X);

                const lon = Math.atan2(Nm[0], Nm[2]) * 180 / Math.PI;
                const lat = Math.asin(Math.max(-1, Math.min(1, Nm[1]))) * 180 / Math.PI;
                const bx = ((Math.floor((lon + 180) / 360 * BM_W) % BM_W) + BM_W) % BM_W;
                const by = Math.max(0, Math.min(BM_H - 1, Math.floor((90 - lat) / 180 * BM_H)));
                const land = isLand(bitmap, bx, by);
                const base = land ? this.landRgb : this.oceanRgb;

                const Nd = dot3(N, LIGHT);
                const diff = smoothstep(-TERMINATOR_SOFTNESS, TERMINATOR_SOFTNESS, Nd);
                const Rv2 = 2 * Nd * N[2] - LIGHT[2];
                const spec = land
                    ? Math.pow(Math.max(0, Rv2), SPEC_POWER_LAND) * 0.18
                    : Math.pow(Math.max(0, Rv2), SPEC_POWER_OCEAN) * 0.55;
                const lit = 0.38 + 0.58 * diff; // higher ambient floor than Boing Ball's 0.12 — night side stays dim, not black

                rgba[idx] = Math.round(Math.min(1, base[0] * lit + spec) * 255);
                rgba[idx + 1] = Math.round(Math.min(1, base[1] * lit + spec) * 255);
                rgba[idx + 2] = Math.round(Math.min(1, base[2] * lit + spec) * 255);
                rgba[idx + 3] = 255;
            }
        }

        const imgX = localX - size / 2;
        const imgY = y - size / 2;
        return `<image x="${imgX}" y="${imgY}" width="${size}" height="${size}" href="${encodePngDataUri(size, size, rgba)}"/>`;
    }

    renderSlice(offsetX: number, width: number, height: number): string {
        const y = this.globeY();
        const floorLineY = height * 0.63;
        const distToFloor = Math.max(0, this.floorY() - y);
        const shadowT = 1 - distToFloor / this.peakAmplitude();
        const shadowOpacity = Math.max(0, Math.min(0.55, 0.55 * shadowT));
        const r = this.radius;
        const shadowRx = r * (0.70 + 0.15 * shadowT);
        const shadowRy = r * 0.09;

        const localX = this.x - offsetX;
        if (localX + r < 0 || localX - r > width) return '';

        let out = `<ellipse cx="${localX}" cy="${floorLineY + shadowRy}" rx="${shadowRx}" ry="${shadowRy}" fill="#000" opacity="${shadowOpacity}"/>`;
        out += this.renderGlobeAt(localX, y);
        return out;
    }

    onSettingsChange(settings: BoingGlobeEffectSettings): void {
        if (settings.landColor) this.landRgb = hexToRgb01(settings.landColor);
        if (settings.oceanColor) this.oceanRgb = hexToRgb01(settings.oceanColor);
        // Also applied live (not just on first initPanorama) — lets a PI speed slider edit take
        // effect immediately on an already-running instance, same as onRotate does. Preserves
        // current drift direction, only magnitude changes.
        if (settings.savedSpeed !== undefined) {
            const sign = this.vx >= 0 ? 1 : -1;
            this.vx = sign * Math.max(SPEED_MIN, Math.min(SPEED_MAX, settings.savedSpeed));
        }
    }

    onRotate(ticks: number): void {
        const sign = this.vx >= 0 ? 1 : -1;
        const current = Math.abs(this.vx);
        const next = Math.max(SPEED_MIN, Math.min(SPEED_MAX, current + ticks * SPEED_STEP));
        this.vx = sign * next;
    }

    // A poke — start a fresh bounce right now.
    onPress(): void {
        this.bouncePhase = 0;
    }

    getIndicatorValue(): number {
        return Math.round((Math.abs(this.vx) - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100);
    }

    getRuntimeSettings(): Partial<BoingGlobeEffectSettings> {
        return { savedSpeed: Math.abs(this.vx) };
    }
}

const boingGlobeEffect: EffectDefinition<BoingGlobeEffectSettings> = {
    id: 'boing-globe',
    displayName: 'Boing Globe',
    // Same bounce motion as Boing Ball — see its preferredTickMs comment / types.ts's doc comment.
    preferredTickMs: 50,
    defaultSettings: { landColor: '#87AE73', oceanColor: '#1C3E6C' },
    settingsSchema: [
        { key: 'landColor', type: 'color', label: 'Land color', default: '#87AE73' },
        { key: 'oceanColor', type: 'color', label: 'Ocean color', default: '#1C3E6C' },
        // Deliberately simplified to a clean 1-5 integer scale for the PI — see the identical
        // comment in boing-ball/index.ts (same underlying tuning range/reasoning).
        { key: 'savedSpeed', type: 'range', label: 'Drift speed', min: 1, max: 5, step: 1, default: 2 },
    ],
    createInstance: () => new BoingGlobeEffectInstance(),
};

export default boingGlobeEffect;
