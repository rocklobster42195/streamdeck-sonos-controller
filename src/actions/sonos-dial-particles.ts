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
import { panoramaOrchestrator, panoramaColumns, panoramaContextGroupKey, getPanoramaSliceOffset, groupEffects, safeEffectCall, DISPLAY_W, DISPLAY_H } from "../effects/PanoramaOrchestrator";
import { effectRegistry } from "../effects/registry.generated";
import type { EffectInstance } from "../effects/types";
import type { ParticlesEffectSettings } from "../effects/particles";
import { piT } from "../utils/pi-i18n";

type ParticlesSettings = {
    // Which registered effect this dial runs. Optional so existing installs (saved before this
    // field existed) fall back to the original behavior — see DEFAULT_EFFECT_ID.
    effectId?: string;
    deviceIp?: string;
    staticColor?: string;
    showTrackInfo?: boolean;
    // Mirror ParticlesEffectSettings' persisted fields — kept as a separate flat type (not an
    // intersection) because intersecting with ParticlesEffectSettings breaks the Stream Deck
    // SDK's JsonObject structural constraint check.
    savedDensity?: number; // particles per display — scales automatically with group size
    savedSpeed?: number;
    // Boing Ball's settingsSchema fields. Flat and effect-specific rather than namespaced per
    // effect id (e.g. `effectSettings.boing-ball.primaryColor`) — simplest thing that works with
    // only two effects; revisit with namespacing once a field-name collision actually happens.
    primaryColor?: string;
    secondaryColor?: string;
};

const DEFAULT_EFFECT_ID = 'particles';
const particlesEffect = effectRegistry.get(DEFAULT_EFFECT_ID)!;

const TICK_INTERVAL = 50;
const DEFAULT_COLOR = '#404040';

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-particles" })
export class SonosDialParticles extends SingletonAction<ParticlesSettings> {

    constructor() {
        super();
        // Registered once at plugin startup (this action is always instantiated in
        // plugin.ts), independent of whether a Panorama Effects tile is currently placed —
        // so Track/Volume/Group Volume dials can form a panorama group among themselves too.
        panoramaOrchestrator.setGroupSyncHandler((grouping) => this.syncGroups(grouping));
    }

    private groupContexts = new Map<string, Set<string>>();
    // Full membership per group (own tiles AND external participants like Track Dial), used
    // purely to dispatch a synchronized render after each tick — see PanoramaOrchestrator's
    // renderCallbacks. `groupContexts` above stays scoped to "own tiles" for settings propagation.
    private groupAllMembers = new Map<string, string[]>();
    private groupTimers = new Map<string, NodeJS.Timeout>();
    private groupControllers = new Map<string, { controller: SonosDeviceController; ip: string }>();
    private groupStaticColor = new Map<string, string>();
    // Alias to the module-level map (see PanoramaOrchestrator.ts) so Track/Volume/Group Volume
    // dial can render their own slice of whichever effect is running, without depending on this
    // action's instance at all.
    private groupEffects = groupEffects as Map<string, EffectInstance<ParticlesEffectSettings>>;
    private groupTrackInfo = new Map<string, { title: string; artist: string }>();
    private groupShowTrackInfo = new Map<string, boolean>();

    private settingsMap = new Map<string, ParticlesSettings>();
    // Alias to module-level map so all code using this.contextGroupKey still works.
    private contextGroupKey = panoramaContextGroupKey;
    private renderGen = new Map<string, number>();

    private persistTimers = new Map<string, NodeJS.Timeout>();

    // ── Helpers ─────────────────────────────────────────────────────────────

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
    // Group computation itself (column adjacency, connected components, debounced
    // scheduling) lives in PanoramaOrchestrator; this method is registered there as the
    // group-sync handler and owns everything effect/device/color-specific.

    private async syncGroups(newGrouping: Map<string, string[]>): Promise<void> {
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
        this.groupAllMembers.delete(key);
        const gc = this.groupControllers.get(key);
        if (gc) {
            gc.controller.unregisterTrackInfoCallback(`pano-color-${key}`);
            sonosDeviceManager.releaseController(gc.ip);
            this.groupControllers.delete(key);
        }
        this.groupEffects.get(key)?.destroy?.();
        this.groupEffects.delete(key);
        // Clear group key for ALL participants, including external actions (e.g. Track Dial).
        for (const [ctx, k] of [...panoramaContextGroupKey.entries()]) {
            if (k === key) panoramaContextGroupKey.delete(ctx);
        }
        this.groupContexts.delete(key);
        this.groupStaticColor.delete(key);
        this.groupTrackInfo.delete(key);
        this.groupShowTrackInfo.delete(key);
    }

    // Gathers every effect-relevant field from the group's members into one settings bag. Passed
    // into initPanorama/onSettingsChange regardless of which effect is active — each effect only
    // reads the keys it cares about (e.g. Particles reads color/savedDensity/savedSpeed, Boing
    // Ball reads primaryColor/secondaryColor/savedSpeed) and ignores the rest.
    private gatherEffectSettings(key: string, ctxs: string[]): Record<string, unknown> {
        let savedDensity: number | undefined;
        let savedSpeed: number | undefined;
        let savedColor: string | undefined;
        let primaryColor: string | undefined;
        let secondaryColor: string | undefined;
        for (const ctx of ctxs) {
            const s = this.settingsMap.get(ctx);
            if (!s) continue;
            if (s.savedDensity !== undefined && savedDensity === undefined) savedDensity = s.savedDensity;
            if (s.savedSpeed !== undefined && savedSpeed === undefined) savedSpeed = s.savedSpeed;
            if (s.staticColor && !savedColor) savedColor = s.staticColor;
            if (s.primaryColor && !primaryColor) primaryColor = s.primaryColor;
            if (s.secondaryColor && !secondaryColor) secondaryColor = s.secondaryColor;
        }
        const color = this.groupStaticColor.get(key) ?? savedColor ?? DEFAULT_COLOR;
        return { color, savedDensity, savedSpeed, primaryColor, secondaryColor };
    }

    // computeAllGroups() only ever merges contexts that share the same contextEffectId, so every
    // member of `ctxs` is guaranteed to already agree — reading any one of them is enough.
    private resolveEffectId(ctxs: string[]): string {
        return panoramaOrchestrator.contextEffectId.get(ctxs[0]) ?? DEFAULT_EFFECT_ID;
    }

    // Destroys the group's current effect instance (if any) and creates+initializes a fresh one
    // of the given effect id. Used both for first-time group setup and for a live effect switch
    // triggered from the PI.
    private switchGroupEffect(key: string, ctxs: string[], effectId: string): void {
        this.groupEffects.get(key)?.destroy?.();
        const def = effectRegistry.get(effectId) ?? particlesEffect;
        const instance = def.createInstance();
        instance.initPanorama({
            width: ctxs.length * DISPLAY_W,
            height: DISPLAY_H,
            settings: this.gatherEffectSettings(key, ctxs),
        });
        this.groupEffects.set(key, instance);
    }

    private async setupGroup(key: string, ctxs: string[]): Promise<void> {
        const numDisplays = ctxs.length;
        this.groupAllMembers.set(key, ctxs);

        if (!this.groupContexts.has(key)) this.groupContexts.set(key, new Set());
        const group = this.groupContexts.get(key)!;
        for (const ctx of ctxs) {
            // Only own Particles instances go into groupContexts for render dispatch.
            // External participants (e.g. Track Dial) render via their own timer.
            if (this.settingsMap.has(ctx)) group.add(ctx);
            this.contextGroupKey.set(ctx, key);
        }

        let effect = this.groupEffects.get(key);
        if (!effect) {
            this.switchGroupEffect(key, ctxs, this.resolveEffectId(ctxs));
            effect = this.groupEffects.get(key)!;
        } else {
            // Membership changed (join/leave) — re-init with the new width. The instance itself
            // decides whether to apply saved values (first creation) or just resize (regroup).
            effect.initPanorama({
                width: numDisplays * DISPLAY_W,
                height: DISPLAY_H,
                settings: this.gatherEffectSettings(key, ctxs),
            });
        }

        if (!this.groupTimers.has(key)) {
            const timer = setInterval(() => {
                const effect = this.groupEffects.get(key);
                if (effect) safeEffectCall(() => effect.tickPanorama(TICK_INTERVAL), undefined, 'tickPanorama');
                // Render every member (own tiles + external participants like Track Dial) from
                // this exact tick, instead of each polling on its own independent timer — keeps
                // every display in the group perfectly in sync.
                const members = this.groupAllMembers.get(key);
                if (members) panoramaOrchestrator.notifyGroupRender(members);
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
                const staticColor = this.settingsMap.get(ctx)?.staticColor;
                if (staticColor) {
                    this.groupStaticColor.set(key, staticColor);
                    effect.onSettingsChange?.({ color: staticColor });
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
                    this.groupEffects.get(key)?.onSettingsChange?.({ color: this.ensureVisibleColor(color) });
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
                    this.groupEffects.get(key)?.onSettingsChange?.({ color: this.ensureVisibleColor(color) });
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
        const effect = key ? this.groupEffects.get(key) : undefined;
        if (!key || !effect) return;

        const runtimeSettings = effect.getRuntimeSettings?.() ?? {};
        const group = this.groupContexts.get(key);
        if (!group) return;

        for (const ctx of group) {
            const ctxSettings = this.settingsMap.get(ctx);
            if (!ctxSettings) continue;
            const updated = { ...ctxSettings, ...runtimeSettings };
            if (JSON.stringify(updated) === JSON.stringify(ctxSettings)) continue;
            this.settingsMap.set(ctx, updated);
            const ctxAction = streamDeck.actions.getActionById(ctx);
            if (ctxAction) await ctxAction.setSettings(updated).catch(() => {});
        }
    }

    // ── Instance lifecycle ───────────────────────────────────────────────────

    override async onWillAppear(ev: WillAppearEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        const col = 'coordinates' in ev.payload
            ? (ev.payload.coordinates as { column: number }).column : 0;
        const settings = ev.payload.settings;

        this.settingsMap.set(context, settings);
        panoramaColumns.set(context, col);
        panoramaOrchestrator.contextEffectId.set(context, settings.effectId ?? DEFAULT_EFFECT_ID);
        panoramaOrchestrator.registerRenderCallback(context, () => this.queueRender(context));

        panoramaOrchestrator.requestSync();
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        const oldSettings = this.settingsMap.get(context);
        const settings = ev.payload.settings;
        this.settingsMap.set(context, settings);

        // Changing effectId can change which contexts belong together (a dial whose effect no
        // longer matches its neighbor's must split off into its own group, and vice versa) — so
        // this always goes through the normal debounced regroup, same as a column join/leave,
        // rather than a special-cased in-place effect swap.
        panoramaOrchestrator.setContextEffectId(context, settings.effectId ?? DEFAULT_EFFECT_ID);

        const key = this.contextGroupKey.get(context);
        if (!key) return;

        if (settings.deviceIp && settings.deviceIp !== oldSettings?.deviceIp) {
            await this.registerGroupDevice(key, settings.deviceIp, context);
        }

        if (settings.staticColor && settings.staticColor !== oldSettings?.staticColor) {
            this.groupStaticColor.set(key, settings.staticColor);
            if (!this.groupControllers.has(key)) {
                this.groupEffects.get(key)?.onSettingsChange?.({ color: settings.staticColor });
            }
            await this.propagateGroupSetting(key, (s) => ({ ...s, staticColor: settings.staticColor }), context);
        }

        if (
            (settings.primaryColor && settings.primaryColor !== oldSettings?.primaryColor) ||
            (settings.secondaryColor && settings.secondaryColor !== oldSettings?.secondaryColor)
        ) {
            const group = this.groupContexts.get(key);
            const ctxs = group && group.size > 0 ? [...group] : [context];
            this.groupEffects.get(key)?.onSettingsChange?.(this.gatherEffectSettings(key, ctxs));
            await this.propagateGroupSetting(key, (s) => ({
                ...s,
                ...(settings.primaryColor ? { primaryColor: settings.primaryColor } : {}),
                ...(settings.secondaryColor ? { secondaryColor: settings.secondaryColor } : {}),
            }), context);
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
        panoramaOrchestrator.contextEffectId.delete(context);
        panoramaOrchestrator.unregisterRenderCallback(context);
        this.settingsMap.delete(context);
        this.renderGen.delete(context);
        // Remaining instances may form different groups (e.g. a gap opened).
        panoramaOrchestrator.requestSync();
    }

    // ── Dial interaction ─────────────────────────────────────────────────────

    override async onDialRotate(ev: DialRotateEvent<ParticlesSettings>): Promise<void> {
        const context = ev.action.id;
        const key = this.contextGroupKey.get(context);
        const effect = key ? this.groupEffects.get(key) : undefined;
        if (!key || !effect) return;

        safeEffectCall(() => effect.onRotate?.(ev.payload.ticks), undefined, 'onRotate');
        this.schedulePersist(key, context);
    }

    // Press toggles between adjusting particle count and animation speed.
    override async onDialDown(ev: DialDownEvent<ParticlesSettings>): Promise<void> {
        const key = this.contextGroupKey.get(ev.action.id);
        const effect = key ? this.groupEffects.get(key) : undefined;
        if (!key || !effect) return;
        safeEffectCall(() => effect.onPress?.(), undefined, 'onPress');
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
            if (ev.payload.event === 'get-effects') {
                const items = [...effectRegistry.values()].map(def => ({ label: piT(def.displayName), value: def.id }));
                streamDeck.ui.sendToPropertyInspector({ event: 'get-effects', items });
            }
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction || !sdAction.isDial()) return;

        const key = this.contextGroupKey.get(context);
        const effect = key ? this.groupEffects.get(key) : undefined;
        const sliceOffsetX = this.getSliceOffset(context);

        const fragment = effect ? safeEffectCall(() => effect.renderSlice(sliceOffsetX, DISPLAY_W, DISPLAY_H), '', 'renderSlice') : '';

        const myCol = panoramaColumns.get(context) ?? 0;
        const cols = key ? panoramaOrchestrator.colsFromKey(key) : [myCol];
        const maxCol = Math.max(...cols);
        const showTrackInfo = !!key && (this.groupShowTrackInfo.get(key) ?? false);
        const trackInfo = showTrackInfo ? (this.groupTrackInfo.get(key!) ?? null) : null;

        // Text anchor at x=196 of the rightmost display, expressed in this display's local coords.
        // With text-anchor="end", long titles overflow leftward into adjacent displays naturally.
        const textAnchorX = 196 + (maxCol - myCol) * DISPLAY_W;

        const titleW = trackInfo?.title ? this.estimateTextWidth(trackInfo.title, 20, true) : 0;
        const artistW = trackInfo?.artist ? this.estimateTextWidth(trackInfo.artist, 15) : 0;

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            '  <clipPath id="c"><rect width="200" height="100"/></clipPath>',
            '</defs>',
            '<rect width="200" height="100" fill="#000"/>',
            `<g clip-path="url(#c)">${fragment}</g>`,
            trackInfo?.title ? `<rect x="${textAnchorX - titleW - 4}" y="49" width="${titleW + 8}" height="27" rx="3" fill="#000" fill-opacity="0.7" clip-path="url(#c)"/>` : '',
            trackInfo?.title ? `<text x="${textAnchorX}" y="72" fill="#fff" font-family="Arial,sans-serif" font-size="20" font-weight="500" text-anchor="end" clip-path="url(#c)">${this.escapeXml(trackInfo.title)}</text>` : '',
            trackInfo?.artist ? `<rect x="${textAnchorX - artistW - 4}" y="77" width="${artistW + 8}" height="20" rx="3" fill="#000" fill-opacity="0.7" clip-path="url(#c)"/>` : '',
            trackInfo?.artist ? `<text x="${textAnchorX}" y="93" fill="#aaa" font-family="Arial,sans-serif" font-size="15" text-anchor="end" clip-path="url(#c)">${this.escapeXml(trackInfo.artist)}</text>` : '',
            '</svg>',
        ].join('');

        const indicatorValue = effect ? safeEffectCall(() => effect.getIndicatorValue?.() ?? 0, 0, 'getIndicatorValue') : 0;

        const finalImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

        await sdAction.setFeedback({
            'full-canvas': finalImage,
            'icon': '',
            'title': '',
            'indicator': { 'value': indicatorValue },
        }).catch(() => {});
    }

    private estimateTextWidth(text: string, fontSize: number, bold = false): number {
        return Math.ceil(text.length * fontSize * (bold ? 0.58 : 0.55)) + 4;
    }

    private escapeXml(s: string): string {
        return s.replace(/[<>&"']/g, c =>
            ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
    }
}
