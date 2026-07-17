import { particleEngine } from "./ParticleEngine";
import type { EffectDefinition, EffectInstance, PanoramaInitContext } from "../types";

export interface ParticlesEffectSettings {
    // Optional (not `color: string`) so an empty `{}` settings object — e.g. a freshly placed
    // dial before any settings have been saved — stays a valid value for this type.
    color?: string;
    savedDensity?: number; // particles per display — scales automatically with group size
    savedSpeed?: number;
}

const DEFAULT_COLOR = '#404040';
const BASE_PER_DISPLAY = 28;
const MIN_PER_DISPLAY = 4;
const MAX_PER_DISPLAY = 40;
const SPEED_MIN = 0.05;
const SPEED_MAX = 1.5;
const SPEED_DEFAULT = 0.25;
const SPEED_STEP = 0.05;

let instanceCounter = 0;

/**
 * Thin adapter around the existing ParticleEngine singleton. Each instance gets its own
 * internally-generated key so it never needs to know the host's group key — this is what lets
 * ParticleEngine's shared-panorama perf optimization (compute the O(n^2) network-lines pass once
 * per group, not once per display) keep working unchanged underneath the generic interface.
 */
class ParticlesEffectInstance implements EffectInstance<ParticlesEffectSettings> {
    private readonly key = `effect-particles-${++instanceCounter}`;
    private numDisplays = 1;
    private density = BASE_PER_DISPLAY;
    private speed = SPEED_DEFAULT;
    private mode: 'particles' | 'speed' = 'particles';

    initPanorama(ctx: PanoramaInitContext<ParticlesEffectSettings>): void {
        this.numDisplays = Math.max(1, Math.round(ctx.width / 200));

        if (!particleEngine.isPanoramaActive(this.key)) {
            // Only apply saved/restored values on first creation — a later call (membership
            // change) must not reset live-tuned density/speed back to the saved snapshot.
            // Clamped, not used verbatim: a tile saved before MIN/MAX_PER_DISPLAY existed (or
            // before they were last retuned) can hold a stale value outside the current valid
            // range — e.g. a saved density of 1-2 from long before MIN_PER_DISPLAY=4 existed,
            // which would otherwise silently override BASE_PER_DISPLAY forever since only
            // onRotate used to clamp, never the initial load.
            this.density = Math.max(MIN_PER_DISPLAY, Math.min(MAX_PER_DISPLAY, ctx.settings.savedDensity ?? this.density));
            this.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, ctx.settings.savedSpeed ?? this.speed));
            particleEngine.initPanorama(this.key, {
                width: ctx.width,
                height: ctx.height,
                count: this.density * this.numDisplays,
                color: ctx.settings.color ?? DEFAULT_COLOR,
                mode: 'network',
                maxSpeed: this.speed,
                connectDistance: 60,
                minRadius: 2,
                maxRadius: 5,
                opacity: 0.9,
            });
        } else {
            // Membership changed (join/leave) — resize particle count to match the new width.
            particleEngine.setParticleCount(this.key, this.density * this.numDisplays);
        }
    }

    tickPanorama(): void {
        particleEngine.tickPanorama(this.key);
    }

    renderSlice(offsetX: number): string {
        return particleEngine.renderPanoramaSlice(this.key, offsetX);
    }

    onSettingsChange(settings: ParticlesEffectSettings): void {
        if (settings.color) particleEngine.transitionPanoramaColor(this.key, settings.color);
        // Also applied live (not just on first initPanorama) — lets a PI density/speed slider
        // edit take effect immediately on an already-running instance, same as onRotate does.
        if (settings.savedDensity !== undefined) {
            this.density = Math.max(MIN_PER_DISPLAY, Math.min(MAX_PER_DISPLAY, settings.savedDensity));
            particleEngine.setParticleCount(this.key, this.density * this.numDisplays);
        }
        if (settings.savedSpeed !== undefined) {
            this.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, settings.savedSpeed));
            particleEngine.setPanoramaSpeed(this.key, this.speed);
        }
    }

    onRotate(ticks: number): void {
        if (this.mode === 'speed') {
            const raw = this.speed + ticks * SPEED_STEP;
            this.speed = parseFloat(Math.max(SPEED_MIN, Math.min(SPEED_MAX, raw)).toFixed(2));
            particleEngine.setPanoramaSpeed(this.key, this.speed);
        } else {
            this.density = Math.min(MAX_PER_DISPLAY, Math.max(MIN_PER_DISPLAY, this.density + ticks));
            particleEngine.setParticleCount(this.key, this.density * this.numDisplays);
        }
    }

    onPress(): void {
        this.mode = this.mode === 'particles' ? 'speed' : 'particles';
    }

    getIndicatorValue(): number {
        if (this.mode === 'speed') {
            return Math.round((this.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100);
        }
        return Math.round((this.density - MIN_PER_DISPLAY) / (MAX_PER_DISPLAY - MIN_PER_DISPLAY) * 100);
    }

    getRuntimeSettings(): Partial<ParticlesEffectSettings> {
        return { savedDensity: this.density, savedSpeed: this.speed };
    }

    destroy(): void {
        particleEngine.destroyPanorama(this.key);
    }
}

const particlesEffect: EffectDefinition<ParticlesEffectSettings> = {
    id: 'particles',
    displayName: 'Particles',
    defaultSettings: { color: '#404040' },
    settingsSchema: [
        { key: 'savedDensity', type: 'range', label: 'Particle density', min: MIN_PER_DISPLAY, max: MAX_PER_DISPLAY, default: BASE_PER_DISPLAY },
        { key: 'savedSpeed', type: 'range', label: 'Particle speed', min: SPEED_MIN, max: SPEED_MAX, step: SPEED_STEP, default: SPEED_DEFAULT },
    ],
    createInstance: () => new ParticlesEffectInstance(),
};

export default particlesEffect;
