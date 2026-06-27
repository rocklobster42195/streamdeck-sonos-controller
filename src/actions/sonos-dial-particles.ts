import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    DialDownEvent,
    WillAppearEvent,
    SingletonAction,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
    SendToPluginEvent,
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { getDominantColor } from "../utils/colorExtract";
import { particleEngine } from "../utils/ParticleEngine";

type ParticlesSettings = {
    deviceIp?: string;
    staticColor?: string;
    showTrackInfo?: boolean;
    savedDensity?: number; // particles per display — scales automatically with group size
    savedSpeed?: number;
};

interface InstanceState {
    density: number; // particles per display
    column: number;
}

const DISPLAY_W = 200;
const DISPLAY_H = 100;
const TICK_INTERVAL = 50;
const BASE_PER_DISPLAY = 14;
const MIN_PER_DISPLAY = 4;
const MAX_PER_DISPLAY = 30;
const SPEED_MIN = 0.05;
const SPEED_MAX = 1.5;
const SPEED_DEFAULT = 0.25;
const SPEED_STEP = 0.05;
const DEFAULT_COLOR = '#7EB8F7';

// Shared panorama registry — allows other actions (e.g. SonosDialTrack) to join a panorama group.
export const panoramaColumns = new Map<string, number>();
export const panoramaContextGroupKey = new Map<string, string>();
let _scheduleSyncFn: (() => void) | null = null;

export function registerInPanorama(context: string, column: number): void {
    panoramaColumns.set(context, column);
    _scheduleSyncFn?.();
}

export function unregisterFromPanorama(context: string): void {
    const key = panoramaContextGroupKey.get(context);
    if (key) panoramaContextGroupKey.delete(context);
    panoramaColumns.delete(context);
    _scheduleSyncFn?.();
}

export function getPanoramaSliceOffset(context: string): number {
    const col = panoramaColumns.get(context) ?? 0;
    const key = panoramaContextGroupKey.get(context);
    if (!key) return 0;
    const minCol = Math.min(...key.replace('panorama-cols-', '').split(',').map(Number));
    return (col - minCol) * DISPLAY_W;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-particles" })
export class SonosDialParticles extends SingletonAction<ParticlesSettings> {

    private groupContexts = new Map<string, Set<string>>();
    private groupTimers = new Map<string, NodeJS.Timeout>();
    private groupControllers = new Map<string, { controller: SonosDeviceController; ip: string }>();
    private groupStaticColor = new Map<string, string>();
    private groupDialMode = new Map<string, 'particles' | 'speed'>();
    private groupSpeed = new Map<string, number>();
    private groupTrackInfo = new Map<string, { title: string; artist: string }>();
    private groupShowTrackInfo = new Map<string, boolean>();

    private settingsMap = new Map<string, ParticlesSettings>();
    private instanceStates = new Map<string, InstanceState>();
    // Alias to module-level map so all code using this.contextGroupKey still works.
    private contextGroupKey = panoramaContextGroupKey;
    private renderGen = new Map<string, number>();

    private syncTimer: NodeJS.Timeout | null = null;
    private persistTimers = new Map<string, NodeJS.Timeout>();

    // ── Helpers ─────────────────────────────────────────────────────────────

    private panoramaKey(cols: number[]): string {
        return 'panorama-cols-' + [...cols].sort((a, b) => a - b).join(',');
    }

    private colsFromKey(key: string): number[] {
        return key.replace('panorama-cols-', '').split(',').map(Number);
    }

    private getSliceOffset(context: string): number {
        return getPanoramaSliceOffset(context);
    }

    private ensureVisibleColor(color: string): string {
        const m = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
        if (!m) return DEFAULT_COLOR;
        const [r, g, b] = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= 0.25) return color;
        const mix = (v: number) => Math.min(255, Math.round(v * 255 + 255 * 0.55));
        return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
    }

    private queueRender(context: string): void {
        const gen = (this.renderGen.get(context) ?? 0) + 1;
        this.renderGen.set(context, gen);
        setImmediate(() => {
            if (this.renderGen.get(context) !== gen) return;
            void this.renderDial(context);
        });
    }

    // ── Auto-grouping ────────────────────────────────────────────────────────

    /**
     * Compute connected components from the current column registry.
     * Adjacent columns (differing by 1) form a group.
     * Returns Map<groupKey, contexts[]>.
     */
    private computeAllGroups(): Map<string, string[]> {
        const sorted = [...panoramaColumns.entries()]
            .sort(([, a], [, b]) => a - b);
        const result = new Map<string, string[]>();
        let i = 0;
        while (i < sorted.length) {
            const cols = [sorted[i][1]];
            const ctxs = [sorted[i][0]];
            while (i + 1 < sorted.length && sorted[i + 1][1] === sorted[i][1] + 1) {
                i++;
                cols.push(sorted[i][1]);
                ctxs.push(sorted[i][0]);
            }
            result.set(this.panoramaKey(cols), ctxs);
            i++;
        }
        return result;
    }

    /** Debounce rapid appear/disappear events so one sync handles all at once. */
    private scheduleSyncGroups(): void {
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            void this.syncGroups();
        }, 60);
    }

    private async syncGroups(): Promise<void> {
        const newGrouping = this.computeAllGroups();

        // Find contexts whose group key has changed.
        const toRegroup = new Set<string>();
        for (const [key, ctxs] of newGrouping) {
            for (const ctx of ctxs) {
                if (this.contextGroupKey.get(ctx) !== key) toRegroup.add(ctx);
            }
        }
        if (toRegroup.size === 0) return;

        // Save state once per old group before tearing anything down.
        const savedGroups = new Set<string>();
        for (const ctx of toRegroup) {
            const oldKey = this.contextGroupKey.get(ctx);
            if (oldKey && !savedGroups.has(oldKey)) {
                await this.saveGroupStateToSettings(ctx);
                savedGroups.add(oldKey);
            }
            this.leaveGroup(ctx);
        }

        // Join new groups.
        for (const [key, ctxs] of newGrouping) {
            if (!ctxs.some(c => toRegroup.has(c))) continue;
            await this.setupGroup(key, ctxs);
        }

        for (const ctx of toRegroup) {
            await this.renderDial(ctx);
        }
    }

    private leaveGroup(context: string): void {
        const key = this.contextGroupKey.get(context);
        if (!key) return;
        this.contextGroupKey.delete(context);
        const group = this.groupContexts.get(key);
        if (!group) return;
        group.delete(context);
        if (group.size === 0) this.destroyGroup(key);
    }

    private destroyGroup(key: string): void {
        const persistTimer = this.persistTimers.get(key);
        if (persistTimer) { clearTimeout(persistTimer); this.persistTimers.delete(key); }
        const timer = this.groupTimers.get(key);
        if (timer) { clearInterval(timer); this.groupTimers.delete(key); }
        const gc = this.groupControllers.get(key);
        if (gc) {
            gc.controller.unregisterTrackInfoCallback(`pano-color-${key}`);
            sonosDeviceManager.releaseController(gc.ip);
            this.groupControllers.delete(key);
        }
        particleEngine.destroyPanorama(key);
        // Clear group key for ALL participants, including external actions (e.g. Track Dial).
        for (const [ctx, k] of [...panoramaContextGroupKey.entries()]) {
            if (k === key) panoramaContextGroupKey.delete(ctx);
        }
        this.groupContexts.delete(key);
        this.groupDialMode.delete(key);
        this.groupSpeed.delete(key);
        this.groupStaticColor.delete(key);
        this.groupTrackInfo.delete(key);
        this.groupShowTrackInfo.delete(key);
    }

    private async setupGroup(key: string, ctxs: string[]): Promise<void> {
        const numDisplays = ctxs.length;

        if (!this.groupContexts.has(key)) this.groupContexts.set(key, new Set());
        const group = this.groupContexts.get(key)!;
        for (const ctx of ctxs) {
            // Only own Particles instances go into groupContexts for render dispatch.
            // External participants (e.g. Track Dial) render via their own timer.
            if (this.settingsMap.has(ctx)) group.add(ctx);
            this.contextGroupKey.set(ctx, key);
        }

        if (!particleEngine.isPanoramaActive(key)) {
            // Restore saved state from whichever group member has one.
            let savedDensity: number | undefined;
            let savedSpeed: number | undefined;
            let savedColor: string | undefined;
            for (const ctx of ctxs) {
                const s = this.settingsMap.get(ctx);
                if (!s) continue;
                if (s.savedDensity !== undefined && savedDensity === undefined) savedDensity = s.savedDensity;
                if (s.savedSpeed !== undefined && savedSpeed === undefined) savedSpeed = s.savedSpeed;
                if (s.staticColor && !savedColor) savedColor = s.staticColor;
            }

            const density = savedDensity ?? BASE_PER_DISPLAY;
            const count = density * numDisplays;
            const speed = savedSpeed ?? SPEED_DEFAULT;
            const color = this.groupStaticColor.get(key) ?? savedColor ?? DEFAULT_COLOR;

            particleEngine.initPanorama(key, {
                width: numDisplays * DISPLAY_W,
                height: DISPLAY_H,
                count,
                color,
                mode: 'network',
                maxSpeed: speed,
                connectDistance: 60,
                minRadius: 2,
                maxRadius: 5,
                opacity: 0.9,
            });

            this.groupSpeed.set(key, speed);
            for (const ctx of ctxs) {
                if (!this.settingsMap.has(ctx)) continue; // Skip external participants
                const col = panoramaColumns.get(ctx) ?? 0;
                this.instanceStates.set(ctx, { density, column: col });
            }
        }

        if (!this.groupTimers.has(key)) {
            const timer = setInterval(() => {
                particleEngine.tickPanorama(key);
                const g = this.groupContexts.get(key);
                if (g) for (const ctx of g) this.queueRender(ctx);
            }, TICK_INTERVAL);
            this.groupTimers.set(key, timer);
        }

        // Find a device from any group member and connect it.
        for (const ctx of ctxs) {
            const ip = this.settingsMap.get(ctx)?.deviceIp;
            if (ip) {
                await this.registerGroupDevice(key, ip, ctx);
                break;
            }
        }

        // Apply static color if no device is connected.
        if (!this.groupControllers.has(key)) {
            for (const ctx of ctxs) {
                const color = this.settingsMap.get(ctx)?.staticColor;
                if (color) {
                    this.groupStaticColor.set(key, color);
                    particleEngine.setPanoramaColor(key, color);
                    break;
                }
            }
        }

        // Derive group-level showTrackInfo from any member opting in.
        const showTrackInfo = ctxs.some(c => this.settingsMap.get(c)?.showTrackInfo);
        this.groupShowTrackInfo.set(key, showTrackInfo);

        // Propagate shared settings (device, color, showTrackInfo) to all group members.
        const sharedIp = this.groupControllers.get(key)?.ip;
        const sharedColor = this.groupStaticColor.get(key);
        if (sharedIp || sharedColor || showTrackInfo) {
            await this.propagateGroupSetting(key, (s) => ({
                ...s,
                ...(sharedIp ? { deviceIp: sharedIp } : {}),
                ...(sharedColor ? { staticColor: sharedColor } : {}),
                ...(showTrackInfo ? { showTrackInfo: true } : {}),
            }));
        }
    }

    // ── Device & color management ────────────────────────────────────────────

    private async registerGroupDevice(key: string, ip: string, triggeringContext: string): Promise<void> {
        const existing = this.groupControllers.get(key);
        if (existing?.ip === ip) return;

        if (existing) {
            existing.controller.unregisterTrackInfoCallback(`pano-color-${key}`);
            sonosDeviceManager.releaseController(existing.ip);
            this.groupControllers.delete(key);
        }

        try {
            const controller = await sonosDeviceManager.getController(ip);
            this.groupControllers.set(key, { controller, ip });

            // Fetch current track immediately so color + title are correct after a page swipe.
            controller.getCurrentTrack().then(track => {
                if (!track) return;
                if (track.Title || track.Artist) {
                    this.groupTrackInfo.set(key, { title: track.Title ?? '', artist: track.Artist ?? '' });
                    const g = this.groupContexts.get(key);
                    if (g) for (const ctx of g) this.queueRender(ctx);
                }
            }).catch(() => {});

            controller.getCurrentTrackCover().then(cover => {
                if (!cover) return;
                getDominantColor(cover).then(color => {
                    particleEngine.setPanoramaColor(key, this.ensureVisibleColor(color));
                }).catch(() => {});
            }).catch(() => {});

            controller.registerTrackInfoCallback(`pano-color-${key}`, (trackInfo) => {
                this.groupTrackInfo.set(key, {
                    title: trackInfo.Title ?? '',
                    artist: trackInfo.Artist ?? '',
                });
                const g = this.groupContexts.get(key);
                if (g) for (const ctx of g) this.queueRender(ctx);

                const art = trackInfo.albumArtDataUri;
                if (!art) return;
                getDominantColor(art).then(color => {
                    particleEngine.transitionPanoramaColor(key, this.ensureVisibleColor(color));
                }).catch(() => {});
            });

            await this.propagateGroupSetting(key, (s) => ({ ...s, deviceIp: ip }), triggeringContext);
        } catch (e) {
            streamDeck.logger.error(`Panorama Particles: failed to connect to ${ip}`, e);
        }
    }

    private async propagateGroupSetting(
        key: string,
        updater: (s: ParticlesSettings) => ParticlesSettings,
        excludeContext?: string
    ): Promise<void> {
        const group = this.groupContexts.get(key);
        if (!group) return;
        for (const ctx of group) {
            if (ctx === excludeContext) continue;
            const current = this.settingsMap.get(ctx);
            if (!current) continue;
            const updated = updater(current);
            if (JSON.stringify(updated) === JSON.stringify(current)) continue;
            this.settingsMap.set(ctx, updated);
            const ctxAction = streamDeck.actions.getActionById(ctx);
            if (ctxAction) await ctxAction.setSettings(updated).catch(() => {});
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    // Debounced save triggered on every dial rotation so settings are already
    // persisted before onWillDisappear fires (page swipe race condition fix).
    private schedulePersist(key: string, context: string): void {
        const existing = this.persistTimers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.persistTimers.delete(key);
            void this.saveGroupStateToSettings(context);
        }, 400);
        this.persistTimers.set(key, timer);
    }

    private async saveGroupStateToSettings(context: string): Promise<void> {
        const key = this.contextGroupKey.get(context);
        const state = this.instanceStates.get(context);
        if (!key || !state) return;

        const speed = this.groupSpeed.get(key) ?? SPEED_DEFAULT;
        const density = state.density;
        const group = this.groupContexts.get(key);
        if (!group) return;

        for (const ctx of group) {
            const ctxSettings = this.settingsMap.get(ctx);
            if (!ctxSettings) continue;
            const updated = { ...ctxSettings, savedDensity: density, savedSpeed: speed };
            if (JSON.stringify(updated) === JSON.stringify(ctxSettings)) continue;
            this.settingsMap.set(ctx, updated);
            const ctxAction = streamDeck.actions.getActionById(ctx);
            if (ctxAction) await ctxAction.setSettings(updated).catch(() => {});
        }
    }

    // ── Instance lifecycle ───────────────────────────────────────────────────

    override async onWillAppear(ev: WillAppearEvent<ParticlesSettings>): Promise<void> {
        _scheduleSyncFn = () => this.scheduleSyncGroups();
        const context = ev.action.id;
        const col = 'coordinates' in ev.payload
            ? (ev.payload.coordinates as { column: number }).column : 0;
        const settings = ev.payload.settings;

        this.settingsMap.set(context, settings);
        panoramaColumns.set(context, col);
        this.instanceStates.set(context, {
            density: settings.savedDensity ?? BASE_PER_DISPLAY,
            column: col,
        });

        this.scheduleSyncGroups();
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        const oldSettings = this.settingsMap.get(context);
        const settings = ev.payload.settings;
        this.settingsMap.set(context, settings);

        const key = this.contextGroupKey.get(context);
        if (!key) return;

        if (settings.deviceIp && settings.deviceIp !== oldSettings?.deviceIp) {
            await this.registerGroupDevice(key, settings.deviceIp, context);
        }

        if (settings.staticColor && settings.staticColor !== oldSettings?.staticColor) {
            this.groupStaticColor.set(key, settings.staticColor);
            if (!this.groupControllers.has(key)) {
                particleEngine.setPanoramaColor(key, settings.staticColor);
            }
            await this.propagateGroupSetting(key, (s) => ({ ...s, staticColor: settings.staticColor }), context);
        }

        if (settings.showTrackInfo !== oldSettings?.showTrackInfo) {
            const show = settings.showTrackInfo === true;
            this.groupShowTrackInfo.set(key, show);
            await this.propagateGroupSetting(key, (s) => ({ ...s, showTrackInfo: show }), context);
            // Re-render all group contexts immediately so the rightmost display updates at once.
            const group = this.groupContexts.get(key);
            if (group) for (const ctx of group) this.queueRender(ctx);
        }

        await this.renderDial(context);
    }

    override async onWillDisappear(ev: WillDisappearEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        await this.saveGroupStateToSettings(context);
        this.leaveGroup(context);
        panoramaColumns.delete(context);
        this.settingsMap.delete(context);
        this.instanceStates.delete(context);
        this.renderGen.delete(context);
        // Remaining instances may form different groups (e.g. a gap opened).
        this.scheduleSyncGroups();
    }

    // ── Dial interaction ─────────────────────────────────────────────────────

    override async onDialRotate(ev: DialRotateEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        const key = this.contextGroupKey.get(context);
        const state = this.instanceStates.get(context);
        if (!key || !state) return;

        const numDisplays = this.groupContexts.get(key)?.size ?? 1;
        const mode = this.groupDialMode.get(key) ?? 'particles';

        if (mode === 'speed') {
            const current = this.groupSpeed.get(key) ?? SPEED_DEFAULT;
            const raw = current + ev.payload.ticks * SPEED_STEP;
            const newSpeed = parseFloat(Math.max(SPEED_MIN, Math.min(SPEED_MAX, raw)).toFixed(2));
            if (newSpeed !== current) {
                this.groupSpeed.set(key, newSpeed);
                particleEngine.setPanoramaSpeed(key, newSpeed);
                this.schedulePersist(key, context);
            }
        } else {
            const newDensity = Math.min(MAX_PER_DISPLAY, Math.max(MIN_PER_DISPLAY, state.density + ev.payload.ticks));
            if (newDensity !== state.density) {
                const group = this.groupContexts.get(key);
                if (group) for (const ctx of group) {
                    const s = this.instanceStates.get(ctx);
                    if (s) s.density = newDensity;
                }
                particleEngine.setParticleCount(key, newDensity * numDisplays);
                this.schedulePersist(key, context);
            }
        }
    }

    // Press toggles between adjusting particle count and animation speed.
    override async onDialDown(ev: DialDownEvent<ParticlesSettings>): Promise<void> {
        const key = this.contextGroupKey.get(ev.action.id);
        if (!key) return;
        const newMode: 'particles' | 'speed' =
            (this.groupDialMode.get(key) ?? 'particles') === 'particles' ? 'speed' : 'particles';
        this.groupDialMode.set(key, newMode);
        const group = this.groupContexts.get(key);
        if (group) for (const ctx of group) this.queueRender(ctx);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, ParticlesSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;
                const deviceItems = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- No device (static color) --', value: '' }, ...deviceItems]
                });
            }
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction || !sdAction.isDial()) return;

        const key = this.contextGroupKey.get(context);
        const state = this.instanceStates.get(context);
        const numDisplays = key ? (this.groupContexts.get(key)?.size ?? 1) : 1;
        const sliceOffsetX = this.getSliceOffset(context);
        const mode = key ? (this.groupDialMode.get(key) ?? 'particles') : 'particles';

        const fragment = key ? particleEngine.renderPanoramaSlice(key, sliceOffsetX) : '';

        const myCol = panoramaColumns.get(context) ?? 0;
        const cols = key ? this.colsFromKey(key) : [myCol];
        const maxCol = Math.max(...cols);
        const isRightmost = myCol === maxCol;
        const showTrackInfo = !!key && (this.groupShowTrackInfo.get(key) ?? false);
        const trackInfo = showTrackInfo ? (this.groupTrackInfo.get(key!) ?? null) : null;

        // Text anchor at x=196 of the rightmost display, expressed in this display's local coords.
        // With text-anchor="end", long titles overflow leftward into adjacent displays naturally.
        const textAnchorX = 196 + (maxCol - myCol) * DISPLAY_W;

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            '  <clipPath id="c"><rect width="200" height="100"/></clipPath>',
            (showTrackInfo && isRightmost) ? '  <linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="30%" stop-color="#000" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.75"/></linearGradient>' : '',
            '</defs>',
            '<rect width="200" height="100" fill="#000"/>',
            `<g clip-path="url(#c)">${fragment}</g>`,
            (showTrackInfo && isRightmost) ? '<rect width="200" height="100" fill="url(#tg)"/>' : '',
            trackInfo?.title ? `<text x="${textAnchorX}" y="72" fill="#fff" font-family="Arial,sans-serif" font-size="20" font-weight="500" text-anchor="end" clip-path="url(#c)">${this.escapeXml(trackInfo.title)}</text>` : '',
            trackInfo?.artist ? `<text x="${textAnchorX}" y="93" fill="#aaa" font-family="Arial,sans-serif" font-size="15" text-anchor="end" clip-path="url(#c)">${this.escapeXml(trackInfo.artist)}</text>` : '',
            '</svg>',
        ].join('');

        let indicatorValue: number;
        if (mode === 'speed') {
            const currentSpeed = key ? (this.groupSpeed.get(key) ?? SPEED_DEFAULT) : SPEED_DEFAULT;
            indicatorValue = Math.round((currentSpeed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN) * 100);
        } else {
            const currentDensity = state?.density ?? BASE_PER_DISPLAY;
            indicatorValue = Math.round((currentDensity - MIN_PER_DISPLAY) / (MAX_PER_DISPLAY - MIN_PER_DISPLAY) * 100);
        }

        const finalImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

        await sdAction.setFeedback({
            'full-canvas': finalImage,
            'icon': '',
            'title': '',
            'indicator': { 'value': indicatorValue },
        }).catch(() => {});
    }

    private escapeXml(s: string): string {
        return s.replace(/[<>&"']/g, c =>
            ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
    }
}
