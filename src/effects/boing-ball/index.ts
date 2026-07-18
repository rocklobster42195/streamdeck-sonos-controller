import type { EffectDefinition, EffectInstance, PanoramaInitContext } from "../types";
import { encodePngDataUri } from "../shared/png";

// Ports the raytraced checkered-sphere look already designed and tuned in
// local/tools/generate-boing-gif.mjs (sage + white checker, tilt, specular highlight) to a live
// Panorama Effect. That script rendered at 2x scale for GIF quality (R=56, "= 28 LCD px" per its
// own comment) — this port uses the real 1x LCD scale directly (R = height * 0.28, etc.).
//
// The sphere is raytraced per-pixel (real 3D lighting/checker-UV-mapping, not a flat rotating
// pattern), but only across the ball's own small bounding box, not the full 200x100 canvas — see
// CONTRIBUTING_EFFECTS.md's Dos and Don'ts. The result is embedded as a PNG data URI via <image>
// (see ../shared/png.ts for why PNG, not e.g. BMP).

export interface BoingBallEffectSettings {
    primaryColor?: string;
    secondaryColor?: string;
    savedSpeed?: number; // px/tick horizontal speed — live-tunable via onRotate
}

// Physics tuned in local/tools/generate-boing-gif.mjs, scaled from its 2x GIF canvas to our real
// 1x LCD scale (divide lengths by 2; tick-counts and angles are scale-invariant).
const FRAMES_HALF = 19; // ticks from floor to peak
const GRAVITY = 0.13; // px/tick^2 (was 0.26 at 2x scale)
const TILT_X = 0.28; // rad, 3/4-view tilt
const SPIN_STEP = Math.PI / (FRAMES_HALF * 2); // rad/tick, constant spin rate
const CHECKER_COLS = 8, CHECKER_ROWS = 8;
const SPEC_POWER = 72;
const LIGHT = norm3([0.5, 0.85, 0.7]);

const BOUNCES_PER_PANEL = 3; // matches "~18 bounces across 6 panels" in the reference script
const SPEED_DEFAULT = 200 / (FRAMES_HALF * 2 * BOUNCES_PER_PANEL); // px/tick
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

function hexToRgb01(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [parseInt(h.substring(0, 2), 16) / 255, parseInt(h.substring(2, 4), 16) / 255, parseInt(h.substring(4, 6), 16) / 255];
}

let instanceCounter = 0;

class BoingBallEffectInstance implements EffectInstance<BoingBallEffectSettings> {
    private readonly id = ++instanceCounter;

    private width = 200;
    private height = 100;
    private radius = 28;

    private x = 100; // virtual position across the whole panorama
    private vx = SPEED_DEFAULT;
    private bouncePhase = 0; // 0..FRAMES_HALF*2, closed-form parabolic arc (see tickPanorama)
    private spin = 0; // rad

    private primaryRgb: [number, number, number] = hexToRgb01('#87AE73'); // sage
    private secondaryRgb: [number, number, number] = [1, 1, 1]; // white

    initPanorama(ctx: PanoramaInitContext<BoingBallEffectSettings>): void {
        const firstInit = this.width === 200 && this.height === 100 && this.bouncePhase === 0 && this.x === 100;
        this.width = ctx.width;
        this.height = ctx.height;
        this.radius = ctx.height * 0.28;
        if (ctx.settings.primaryColor) this.primaryRgb = hexToRgb01(ctx.settings.primaryColor);
        if (ctx.settings.secondaryColor) this.secondaryRgb = hexToRgb01(ctx.settings.secondaryColor);

        if (firstInit) {
            this.vx = ctx.settings.savedSpeed ?? SPEED_DEFAULT;
            this.x = ctx.width / 2;
        } else {
            this.x = Math.min(this.x, Math.max(this.radius, this.width - this.radius));
        }
    }

    private floorY(): number { return this.height - 1 - this.radius; }
    private peakAmplitude(): number { return 0.5 * GRAVITY * FRAMES_HALF * FRAMES_HALF; }

    tickPanorama(): void {
        this.bouncePhase = (this.bouncePhase + 1) % (FRAMES_HALF * 2);

        this.x += this.vx;
        const wallL = this.radius + 2, wallR = this.width - this.radius - 2;
        if (this.x >= wallR) { this.x = wallR; this.vx = -Math.abs(this.vx); }
        if (this.x <= wallL) { this.x = wallL; this.vx = Math.abs(this.vx); }

        // Rolls in its direction of travel — reverses immediately on wall contact along with vx.
        this.spin += Math.sign(this.vx) * SPIN_STEP;
    }

    private ballY(): number {
        const th = this.bouncePhase <= FRAMES_HALF ? this.bouncePhase : FRAMES_HALF * 2 - this.bouncePhase;
        return (this.floorY() - this.peakAmplitude()) + 0.5 * GRAVITY * th * th;
    }

    renderSlice(offsetX: number, width: number, height: number): string {
        const localX = this.x - offsetX;
        if (localX + this.radius < 0 || localX - this.radius > width) return '';

        const y = this.ballY();
        const r = this.radius;
        const size = Math.ceil(r * 2) + 2;
        const rgba = new Uint8ClampedArray(size * size * 4);

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

                const u = (Math.atan2(Nm[0], Nm[2]) / (2 * Math.PI) + 0.5) % 1;
                const v = Math.acos(Math.max(-1, Math.min(1, Nm[1]))) / Math.PI;
                const isPrimary = ((Math.floor(u * CHECKER_COLS) + Math.floor(v * CHECKER_ROWS)) % 2) === 0;
                const base = isPrimary ? this.primaryRgb : this.secondaryRgb;

                const Nd = dot3(N, LIGHT);
                const diff = Math.max(0, Nd);
                const Rv2 = 2 * Nd * N[2] - LIGHT[2];
                const spec = Math.pow(Math.max(0, Rv2), SPEC_POWER);
                const lit = 0.12 + 0.80 * diff;

                rgba[idx] = Math.round(Math.min(1, base[0] * lit + 0.70 * spec) * 255);
                rgba[idx + 1] = Math.round(Math.min(1, base[1] * lit + 0.70 * spec) * 255);
                rgba[idx + 2] = Math.round(Math.min(1, base[2] * lit + 0.70 * spec) * 255);
                rgba[idx + 3] = 255;
            }
        }

        const imgX = localX - size / 2;
        const imgY = y - size / 2;
        const floorLineY = height * 0.63;
        const distToFloor = Math.max(0, this.floorY() - y);
        const shadowT = 1 - distToFloor / this.peakAmplitude();
        const shadowOpacity = Math.max(0, Math.min(0.55, 0.55 * shadowT));
        const shadowRx = r * (0.70 + 0.15 * shadowT);
        const shadowRy = r * 0.09;

        return [
            `<ellipse cx="${localX}" cy="${floorLineY + shadowRy}" rx="${shadowRx}" ry="${shadowRy}" fill="#000" opacity="${shadowOpacity}"/>`,
            `<image x="${imgX}" y="${imgY}" width="${size}" height="${size}" href="${encodePngDataUri(size, size, rgba)}"/>`,
        ].join('');
    }

    onSettingsChange(settings: BoingBallEffectSettings): void {
        if (settings.primaryColor) this.primaryRgb = hexToRgb01(settings.primaryColor);
        if (settings.secondaryColor) this.secondaryRgb = hexToRgb01(settings.secondaryColor);
        // Also applied live (not just on first initPanorama) — lets a PI speed slider edit take
        // effect immediately on an already-running instance, same as onRotate does. Preserves
        // current travel direction, only magnitude changes.
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

    // A poke — start a fresh majestic bounce right now.
    onPress(): void {
        this.bouncePhase = 0;
    }

    getIndicatorValue(): number {
        return Math.round((Math.abs(this.vx) - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100);
    }

    getRuntimeSettings(): Partial<BoingBallEffectSettings> {
        return { savedSpeed: Math.abs(this.vx) };
    }
}

const boingBallEffect: EffectDefinition<BoingBallEffectSettings> = {
    id: 'boing-ball',
    displayName: 'Boing Ball',
    // Fast bounce motion reads as choppy at the plugin-wide 10fps default — see types.ts's doc
    // comment on preferredTickMs.
    preferredTickMs: 50,
    defaultSettings: { primaryColor: '#87AE73', secondaryColor: '#FFFFFF' },
    settingsSchema: [
        { key: 'primaryColor', type: 'color', label: 'Primary color', default: '#87AE73' },
        { key: 'secondaryColor', type: 'color', label: 'Secondary color', default: '#FFFFFF' },
        // Deliberately simplified to a clean 1-5 integer scale for the PI (the true tuning range
        // is ~0.7-5.3 px/tick, fractional — see SPEED_MIN/MAX above, still used for clamping
        // whatever the PI sends and for the fine-grained physical dial-rotate control on the
        // Panorama Effects action). A slider showing "0.7017543859649122" was illegible.
        { key: 'savedSpeed', type: 'range', label: 'Ball speed', min: 1, max: 5, step: 1, default: 2 },
    ],
    createInstance: () => new BoingBallEffectInstance(),
};

export default boingBallEffect;
