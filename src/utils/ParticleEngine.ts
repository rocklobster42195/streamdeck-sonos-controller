export type ParticleMode = 'drift' | 'network';

export interface ParticleConfig {
    width: number;
    height: number;
    count: number;
    color: string;
    mode: ParticleMode;
    maxSpeed?: number;        // px per tick, default 0.4
    connectDistance?: number; // network mode: max line distance, default 30
    minRadius?: number;       // default 0.8
    maxRadius?: number;       // default 2.5
    opacity?: number;         // base opacity, default 0.75
}

interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
}

type ResolvedConfig = Required<ParticleConfig>;

/**
 * Tick-based particle simulation that renders to SVG fragments.
 * Display-size agnostic: pass width/height to init() and offsetX/offsetY to render().
 * Works for small areas (Track Dial bottom strip) and full multi-panel displays alike.
 *
 * Two modes:
 *  - Per-context (init/tick/render/destroy): one simulation per Stream Deck action instance.
 *  - Panorama (initPanorama/tickPanorama/renderPanoramaSlice/destroyPanorama): one simulation
 *    shared across multiple displays; each display renders its own horizontal slice.
 */
export class ParticleEngine {
    private particles: Map<string, Particle[]> = new Map();
    private configs: Map<string, ResolvedConfig> = new Map();

    // Panorama simulations — keyed by group key (e.g. "panorama-2").
    private panoramas: Map<string, { config: ResolvedConfig; particles: Particle[] }> = new Map();

    // Active color transitions for panoramas.
    private colorTransitions: Map<string, {
        fromR: number; fromG: number; fromB: number;
        toR: number; toG: number; toB: number;
        step: number; totalSteps: number;
    }> = new Map();

    // ── Per-context API ──────────────────────────────────────────────────────

    init(context: string, config: ParticleConfig): void {
        const cfg = this.resolve(config);
        this.configs.set(context, cfg);
        this.particles.set(context, this.spawnMany(cfg));
    }

    /** Advance the simulation by one step. Call before render(). */
    tick(context: string): void {
        const cfg = this.configs.get(context);
        const ps = this.particles.get(context);
        if (!cfg || !ps) return;
        for (const p of ps) {
            p.x += p.vx;
            p.y += p.vy;
            // Bounce off boundaries.
            if (p.x - p.r < 0)          { p.x = p.r;             p.vx = Math.abs(p.vx); }
            if (p.x + p.r > cfg.width)   { p.x = cfg.width - p.r; p.vx = -Math.abs(p.vx); }
            if (p.y - p.r < 0)          { p.y = p.r;              p.vy = Math.abs(p.vy); }
            if (p.y + p.r > cfg.height)  { p.y = cfg.height - p.r; p.vy = -Math.abs(p.vy); }
        }
    }

    /** Update the particle color (call when dominant cover color changes). */
    setColor(context: string, color: string): void {
        const cfg = this.configs.get(context);
        if (cfg) cfg.color = color;
    }

    /**
     * Returns an SVG fragment (no wrapping <svg> tag).
     * @param offsetX  x translation — where the particle zone starts in the parent SVG
     * @param offsetY  y translation — where the particle zone starts in the parent SVG
     */
    render(context: string, offsetX = 0, offsetY = 0): string {
        const cfg = this.configs.get(context);
        const ps = this.particles.get(context);
        if (!cfg || !ps) return '';

        const parts: string[] = [];
        const col = cfg.color;
        const op = cfg.opacity;

        if (cfg.mode === 'network') {
            const cd2 = cfg.connectDistance * cfg.connectDistance;
            for (let i = 0; i < ps.length; i++) {
                for (let j = i + 1; j < ps.length; j++) {
                    const dx = ps[i].x - ps[j].x;
                    const dy = ps[i].y - ps[j].y;
                    if (dx * dx + dy * dy < cd2) {
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        const lo = ((1 - dist / cfg.connectDistance) * op).toFixed(2);
                        const x1 = (ps[i].x + offsetX).toFixed(1);
                        const y1 = (ps[i].y + offsetY).toFixed(1);
                        const x2 = (ps[j].x + offsetX).toFixed(1);
                        const y2 = (ps[j].y + offsetY).toFixed(1);
                        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="1.5" opacity="${lo}"/>`);
                    }
                }
            }
        }

        for (const p of ps) {
            const cx = (p.x + offsetX).toFixed(1);
            const cy = (p.y + offsetY).toFixed(1);
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${p.r.toFixed(1)}" fill="${col}" opacity="${op.toFixed(2)}"/>`);
        }

        return parts.join('');
    }

    isActive(context: string): boolean {
        return this.particles.has(context);
    }

    destroy(context: string): void {
        this.particles.delete(context);
        this.configs.delete(context);
    }

    // ── Panorama API ─────────────────────────────────────────────────────────

    /**
     * Initialize a shared simulation for a multi-display panorama.
     * @param key          Unique group key, e.g. "panorama-2"
     * @param config       width = full virtual canvas (all displays + bezels combined)
     */
    initPanorama(key: string, config: ParticleConfig): void {
        const cfg = this.resolve(config);
        this.panoramas.set(key, { config: cfg, particles: this.spawnMany(cfg) });
    }

    tickPanorama(key: string): void {
        const pano = this.panoramas.get(key);
        if (!pano) return;
        const { config: cfg, particles: ps } = pano;

        // Advance any active color transition.
        const tr = this.colorTransitions.get(key);
        if (tr) {
            tr.step++;
            const t = Math.min(tr.step / tr.totalSteps, 1);
            // Ease in-out cubic for a natural feel.
            const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            cfg.color = this.colorToRgb(
                tr.fromR + (tr.toR - tr.fromR) * ease,
                tr.fromG + (tr.toG - tr.fromG) * ease,
                tr.fromB + (tr.toB - tr.fromB) * ease,
            );
            if (tr.step >= tr.totalSteps) this.colorTransitions.delete(key);
        }

        for (const p of ps) {
            p.x += p.vx;
            p.y += p.vy;
            if (p.x - p.r < 0)           { p.x = p.r;              p.vx = Math.abs(p.vx); }
            if (p.x + p.r > cfg.width)    { p.x = cfg.width - p.r;  p.vx = -Math.abs(p.vx); }
            if (p.y - p.r < 0)           { p.y = p.r;               p.vy = Math.abs(p.vy); }
            if (p.y + p.r > cfg.height)   { p.y = cfg.height - p.r; p.vy = -Math.abs(p.vy); }
        }
    }

    /**
     * Render the panorama slice visible on one display.
     * All particles and lines are rendered; the caller applies a clipPath to crop to display bounds.
     * Lines between particles on adjacent displays are drawn on both — the clip handles the cut.
     *
     * @param key          Panorama group key
     * @param sliceOffsetX Virtual x-coordinate of this display's left edge
     * @param canvasX      x offset in the output SVG (typically 0 for full-display renders)
     * @param canvasY      y offset in the output SVG (typically 0)
     */
    renderPanoramaSlice(key: string, sliceOffsetX: number, canvasX = 0, canvasY = 0): string {
        const pano = this.panoramas.get(key);
        if (!pano) return '';
        const { config: cfg, particles: ps } = pano;
        const parts: string[] = [];
        const col = cfg.color;
        const op = cfg.opacity;

        if (cfg.mode === 'network') {
            const cd2 = cfg.connectDistance * cfg.connectDistance;
            for (let i = 0; i < ps.length; i++) {
                for (let j = i + 1; j < ps.length; j++) {
                    const dx = ps[i].x - ps[j].x;
                    const dy = ps[i].y - ps[j].y;
                    if (dx * dx + dy * dy < cd2) {
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        const lo = ((1 - dist / cfg.connectDistance) * op).toFixed(2);
                        const x1 = (ps[i].x - sliceOffsetX + canvasX).toFixed(1);
                        const y1 = (ps[i].y + canvasY).toFixed(1);
                        const x2 = (ps[j].x - sliceOffsetX + canvasX).toFixed(1);
                        const y2 = (ps[j].y + canvasY).toFixed(1);
                        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="2.5" opacity="${lo}"/>`);
                    }
                }
            }
        }

        for (const p of ps) {
            const cx = (p.x - sliceOffsetX + canvasX).toFixed(1);
            const cy = (p.y + canvasY).toFixed(1);
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${p.r.toFixed(1)}" fill="${col}" opacity="${op.toFixed(2)}"/>`);
        }

        return parts.join('');
    }

    /**
     * Adjust the particle count for a panorama group.
     * Removes trailing particles when shrinking; spawns new random ones when growing.
     */
    setParticleCount(key: string, count: number): void {
        const pano = this.panoramas.get(key);
        if (!pano) return;
        pano.config.count = count;
        while (pano.particles.length < count) pano.particles.push(this.spawnOne(pano.config));
        if (pano.particles.length > count) pano.particles.length = count;
    }

    setPanoramaColor(key: string, color: string): void {
        const pano = this.panoramas.get(key);
        if (pano) {
            pano.config.color = color;
            this.colorTransitions.delete(key); // cancel any in-progress transition
        }
    }

    /**
     * Smoothly interpolate from the current panorama color to targetColor over durationMs.
     * Uses cubic ease-in-out; the transition advances one step per tickPanorama() call.
     */
    transitionPanoramaColor(key: string, targetColor: string, durationMs = 2000): void {
        const pano = this.panoramas.get(key);
        if (!pano) return;
        const [fromR, fromG, fromB] = this.parseColor(pano.config.color);
        const [toR, toG, toB] = this.parseColor(targetColor);
        const totalSteps = Math.max(1, Math.round(durationMs / 50));
        this.colorTransitions.set(key, { fromR, fromG, fromB, toR, toG, toB, step: 0, totalSteps });
    }

    /** Scale all current velocities so the simulation runs at a new effective speed. */
    setPanoramaSpeed(key: string, maxSpeed: number): void {
        const pano = this.panoramas.get(key);
        if (!pano || pano.config.maxSpeed === 0) return;
        const scale = maxSpeed / pano.config.maxSpeed;
        pano.config.maxSpeed = maxSpeed;
        for (const p of pano.particles) {
            p.vx *= scale;
            p.vy *= scale;
        }
    }

    destroyPanorama(key: string): void {
        this.panoramas.delete(key);
        this.colorTransitions.delete(key);
    }

    isPanoramaActive(key: string): boolean {
        return this.panoramas.has(key);
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private spawnMany(cfg: ResolvedConfig): Particle[] {
        return Array.from({ length: cfg.count }, () => this.spawnOne(cfg));
    }

    private spawnOne(cfg: ResolvedConfig): Particle {
        const angle = Math.random() * Math.PI * 2;
        const speed = (0.2 + Math.random() * 0.8) * cfg.maxSpeed;
        return {
            x: Math.random() * cfg.width,
            y: Math.random() * cfg.height,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            r: cfg.minRadius + Math.random() * (cfg.maxRadius - cfg.minRadius),
        };
    }

    private parseColor(color: string): [number, number, number] {
        const rgb = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
        const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
        return [126, 184, 247];
    }

    private colorToRgb(r: number, g: number, b: number): string {
        return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    }

    private resolve(c: ParticleConfig): ResolvedConfig {
        return {
            maxSpeed: 0.4,
            connectDistance: 30,
            minRadius: 0.8,
            maxRadius: 2.5,
            opacity: 0.75,
            ...c,
        };
    }
}

export const particleEngine = new ParticleEngine();
