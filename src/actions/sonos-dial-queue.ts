import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    SendToPluginEvent,
    DialRotateEvent,
    DialDownEvent,
    TouchTapEvent,
    DialAction,
} from "@elgato/streamdeck";
import { PanoramaCapableDialAction, PanoramaCapableSettings } from "./PanoramaCapableDialAction";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { Track } from "@svrooij/sonos/lib/models";
import { loadImageFromUri } from "../sonos/utils";
import { wrapIndex, truncateForDisplay } from "../sonos/queueUtils";
import { CoverArtAnimator } from "../utils/CoverArtAnimator";
import { marqueeAnimator } from "../utils/MarqueeAnimator";
import { TrackInfo } from "../sonos/SonosTypes";
import { buildUnconfiguredDialSvg } from "../utils/icons";
import { QueueCoverArtCache } from "./QueueCoverArtCache";
import { piT } from "../utils/pi-i18n";
import { panoramaContextGroupKey, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive } from "../effects/PanoramaOrchestrator";
import { effectRegistry } from "../effects/registry.generated";

type QueueDialSettings = PanoramaCapableSettings & {
    deviceIp?: string;
    // Which side the cover art is drawn on; 'right' matches Track Dial's fixed layout.
    coverPosition?: 'left' | 'right';
    queueTimeoutSeconds?: number;
};

interface QueueDialState {
    trackInfo?: TrackInfo;
    transportState: string;
    playbackKind: 'queue' | 'radio' | 'unknown';
    queueItems: Track[];
    liveTrackIndex: number; // 0-based; -1 = unknown/not applicable
    cursorIndex: number; // -1 = resting (now-playing view); >=0 = browsing (carousel)
    // Cursor row's cover, swapped instantly (no crossfade — scrolling needs to feel immediate).
    // Deliberately NOT routed through CoverArtAnimator, whose ~500ms crossfade made browsing feel
    // sluggish; the resting view still uses the animator for its (intentional) crossfade.
    cursorCoverUri?: string;
    browseTimeoutId?: NodeJS.Timeout;
    browseTimeoutMs: number;
    coverFetchGen: number; // guards against stale cover fetches while scrolling fast
    // Debounces the actual network fetch — see onDialRotate. Without this, fast scrolling fired
    // 3 HTTP requests (cursor + 2 neighbors) per tick at the Sonos speaker's small embedded web
    // server, backing up its connection queue badly enough to also stall unrelated fetches (e.g.
    // Favorites Dial's cover art) against the same device for many seconds.
    coverDebounceTimer?: NodeJS.Timeout;
    fadeOpacity?: number;  // black overlay opacity while leaving browse mode; undefined = no fade
    fadeTimer?: NodeJS.Timeout;
}

const COVER_DEBOUNCE_MS = 150;

const COVER_WIDTH = 87;
const OUTER_MARGIN = 8;
const COVER_TEXT_GAP = 14;
const TEXT_WIDTH = 200 - COVER_WIDTH - COVER_TEXT_GAP - OUTER_MARGIN;

function cursorMarqueeKey(context: string): string {
    return `${context}:cursor`;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-queue" })
export class SonosDialQueue extends PanoramaCapableDialAction<QueueDialSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, QueueDialState> = new Map();
    private animators: Map<string, CoverArtAnimator> = new Map();
    private coverCaches: Map<string, QueueCoverArtCache> = new Map();

    // Panorama effects (Background PI field) render behind the resting view, same as
    // Volume/Track/GroupVolume Dial — uses the base class's default isEffectMode. The carousel
    // stays solid black regardless of mode: an animated background would fight for attention
    // during fast browsing, and renderCarousel never reads visualizerMode.

    private onTransportStateChanged(context: string, transportState: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.transportState = transportState;
        void this.renderDial(context);
    }

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (!state || !animator) return;

        // Preserve visible cover when the new event carries no art (e.g. radio news segment).
        if (!trackInfo.albumArtDataUri && state.trackInfo?.albumArtDataUri) {
            trackInfo = { ...trackInfo, albumArtDataUri: state.trackInfo.albumArtDataUri };
        }
        const wasRadio = state.playbackKind === 'radio';
        state.trackInfo = trackInfo;
        state.playbackKind = trackInfo.isRadio ? 'radio' : 'queue';

        // While actively browsing, external playback progression (someone skips a track, a radio
        // news segment fires, etc.) must not touch the visible carousel — only background state
        // updates here. The one exception: if the source stops being a queue altogether (switched
        // to radio), there's nothing left to browse, so bail back to the resting view.
        if (state.cursorIndex !== -1) {
            if (state.playbackKind === 'radio') this.cancelBrowse(context);
            return;
        }

        animator.updateImage(context, trackInfo.albumArtDataUri);
        marqueeAnimator.update(context, { text: trackInfo.Title ?? '', availableWidth: TEXT_WIDTH });

        // Seed the carousel cache with the cover we already have, so browsing back to the
        // currently-playing item never re-fetches something we're already displaying.
        if (trackInfo.AlbumArtUri && trackInfo.albumArtDataUri) {
            this.coverCaches.get(context)?.set(trackInfo.AlbumArtUri, trackInfo.albumArtDataUri);
        }

        const controller = this.controllers.get(context);
        if (controller) {
            // Radio -> queue transition: eager-fetch the queue so the position/length are ready.
            // Otherwise (still queue, or still radio) just refresh the live position cheaply.
            const fullRefetch = wasRadio && state.playbackKind === 'queue';
            void this.refreshQueueContext(context, controller, fullRefetch);
        }

        void this.renderDial(context);
    }

    // Shuffle/repeat toggles (from this plugin, the Sonos app, or any other client) can reorder
    // the queue container itself — refetch so a subsequent browse reflects the new order. Skipped
    // entirely while actively browsing, same reasoning as onTrackInfoChanged.
    private onPlayModeChanged(context: string): void {
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        if (!state || !controller) return;
        if (state.cursorIndex !== -1 || state.playbackKind !== 'queue') return;
        void this.refreshQueueContext(context, controller, true);
    }

    // Keeps queueItems/liveTrackIndex in sync. `fullRefetch` re-pulls the whole queue (needed on
    // radio->queue transitions, a shuffle/repeat toggle, or first load); otherwise only the cheap
    // position lookup runs. Never called while actively browsing (see call sites).
    private async refreshQueueContext(context: string, controller: SonosDeviceController, fullRefetch: boolean): Promise<void> {
        const state = this.states.get(context);
        if (!state || state.playbackKind !== 'queue') return;
        try {
            if (fullRefetch || state.queueItems.length === 0) {
                state.queueItems = await controller.getQueue();
            }
            state.liveTrackIndex = await controller.getCurrentQueuePosition();
        } catch (e) {
            streamDeck.logger.warn('refreshQueueContext failed', e);
        }
        void this.renderDial(context);
    }

    // Pure state reset — no fade. Used at the black midpoint of startFadeThroughBlack.
    private resetToResting(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.cursorIndex = -1;
        const animator = this.animators.get(context);
        if (animator) animator.updateImage(context, state.trackInfo?.albumArtDataUri);
        marqueeAnimator.update(context, { text: state.trackInfo?.Title ?? '', availableWidth: TEXT_WIDTH });
    }

    // Leaves browse mode via a brief fade-through-black (same technique as Favorites Dial) rather
    // than an instant cut — used for both the auto-return timeout and the radio safety-net exit.
    private cancelBrowse(context: string): void {
        const state = this.states.get(context);
        if (!state || state.cursorIndex === -1) return;
        if (state.browseTimeoutId) { clearTimeout(state.browseTimeoutId); state.browseTimeoutId = undefined; }
        if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = undefined; }

        const STEPS = 6;
        const INTERVAL_MS = 30;
        let phase: 1 | 2 = 1;
        let step = 0;

        state.fadeOpacity = 0;
        void this.renderDial(context);

        state.fadeTimer = setInterval(() => {
            const s = this.states.get(context);
            if (!s) return;
            step++;

            if (phase === 1) {
                s.fadeOpacity = step / STEPS;
                if (step >= STEPS) {
                    phase = 2;
                    step = 0;
                    s.fadeOpacity = 1.0;
                    this.resetToResting(context);
                }
            } else {
                s.fadeOpacity = Math.max(0, 1 - step / STEPS);
                if (step >= STEPS) {
                    s.fadeOpacity = undefined;
                    clearInterval(s.fadeTimer!);
                    s.fadeTimer = undefined;
                }
            }

            void this.renderDial(context);
        }, INTERVAL_MS);
    }

    // queueTimeoutSeconds === 0 disables auto-return entirely — browsing then only ends via
    // Touch or Push.
    private startBrowseTimeout(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        if (state.browseTimeoutMs <= 0) return;
        state.browseTimeoutId = setTimeout(() => {
            const s = this.states.get(context);
            if (s) s.browseTimeoutId = undefined;
            this.cancelBrowse(context);
        }, state.browseTimeoutMs);
    }

    // Synchronous, no network: applies a cached cover for the current cursor if one exists.
    // Called on every rotate tick (cheap — just a Map lookup) so cache hits stay instant even
    // while the actual network fetch below is debounced. Returns true if nothing further needs
    // to be fetched for the current cursor (either applied from cache, or there's no art to get).
    private applyCachedCursorCover(context: string): boolean {
        const state = this.states.get(context);
        const cache = this.coverCaches.get(context);
        if (!state || !cache) return false;

        const item = state.queueItems[state.cursorIndex];
        const key = item?.AlbumArtUri ?? item?.TrackUri ?? '';
        if (!item || !key) { state.cursorCoverUri = undefined; return true; }

        const cached = cache.get(key);
        if (cached) { state.cursorCoverUri = cached; return true; }
        return false;
    }

    // Fetches (and caches) the cover for the currently focused carousel row. Race-guarded via
    // coverFetchGen so a fetch that resolves after the user has already scrolled on doesn't
    // clobber whatever is now in focus. Swaps state.cursorCoverUri directly (no crossfade).
    private async loadCursorCover(context: string): Promise<void> {
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        const cache = this.coverCaches.get(context);
        if (!state || !controller || !cache) return;

        const item = state.queueItems[state.cursorIndex];
        const key = item?.AlbumArtUri ?? item?.TrackUri ?? '';
        if (!item || !key) { state.cursorCoverUri = undefined; void this.renderDial(context); return; }

        const cached = cache.get(key);
        if (cached) { state.cursorCoverUri = cached; void this.renderDial(context); return; }
        if (!item.AlbumArtUri) return;

        const gen = ++state.coverFetchGen;
        try {
            const dataUri = await loadImageFromUri(item.AlbumArtUri, controller.transportDevice);
            if (state.coverFetchGen !== gen) return; // stale — cursor has moved on already
            if (dataUri) {
                cache.set(key, dataUri);
                state.cursorCoverUri = dataUri;
                void this.renderDial(context);
            }
        } catch { /* keep whatever is currently shown */ }
    }

    // Warms the cache for one queue item without touching cursorCoverUri/render — used to
    // pre-fetch the carousel's immediate neighbors so sequential single-step scrolling (the
    // common case) usually finds its next cover already cached instead of fetching-then-waiting.
    private async prefetchCover(context: string, item: Track | undefined): Promise<void> {
        const controller = this.controllers.get(context);
        const cache = this.coverCaches.get(context);
        if (!controller || !cache || !item?.AlbumArtUri) return;
        const key = item.AlbumArtUri ?? item.TrackUri ?? '';
        if (!key || cache.has(key)) return;
        try {
            const dataUri = await loadImageFromUri(item.AlbumArtUri, controller.transportDevice);
            if (dataUri) cache.set(key, dataUri);
        } catch { /* best effort — a later loadCursorCover call will just retry */ }
    }

    protected override async onInstanceUpdate(ev: WillAppearEvent<QueueDialSettings> | DidReceiveSettingsEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        let settings = ev.payload.settings;

        this.cleanupInstance(context);

        settings = this.applyBackfill(ev, settings, { coverPosition: 'right', queueTimeoutSeconds: 5 });

        const { deviceIp } = settings;
        this.settingsMap.set(context, settings);

        const animator = new CoverArtAnimator();
        this.animators.set(context, animator);
        animator.start(context, () => { void this.renderDial(context); });

        marqueeAnimator.start(context, () => { void this.renderDial(context); }, {
            text: '',
            fontSize: 14,
            fontColor: '#FFFFFF',
            availableWidth: TEXT_WIDTH,
        });
        marqueeAnimator.start(cursorMarqueeKey(context), () => { void this.renderDial(context); }, {
            text: '',
            fontSize: 15,
            fontColor: '#FFFFFF',
            availableWidth: TEXT_WIDTH,
        });

        this.coverCaches.set(context, new QueueCoverArtCache());

        this.states.set(context, {
            transportState: 'STOPPED',
            playbackKind: 'unknown',
            queueItems: [],
            liveTrackIndex: -1,
            cursorIndex: -1,
            browseTimeoutMs: (settings.queueTimeoutSeconds ?? 5) * 1000,
            coverFetchGen: 0,
        });

        this.syncPanoramaParticipation(context, settings);

        await this.renderDial(context);

        if (!deviceIp) return;

        try {
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
            // Fires immediately with cached state (incl. isRadio) if a track is already known.
            controller.registerTrackInfoCallback(context, (ti) => this.onTrackInfoChanged(context, ti));
            controller.registerPlayModeCallback(context, () => this.onPlayModeChanged(context));

            const [transportState, track] = await Promise.all([
                controller.getTransportState(),
                controller.getCurrentTrack(),
            ]);

            const state = this.states.get(context)!;
            state.transportState = transportState;
            if (track && !state.trackInfo) state.trackInfo = track;

            // For radio, getCurrentTrack() returns undefined; derive cover from stream URI.
            const cover = await controller.getCurrentTrackCover();
            if (cover) {
                if (!state.trackInfo) state.trackInfo = {} as TrackInfo;
                state.trackInfo.albumArtDataUri = cover;
                animator.updateImage(context, cover);
                marqueeAnimator.update(context, { text: state.trackInfo.Title ?? '', availableWidth: TEXT_WIDTH });
            }

            if (state.playbackKind === 'queue') {
                await this.refreshQueueContext(context, controller, true);
            }

            await this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
        }
    }

    protected cleanupInstance(context: string): void {
        const state = this.states.get(context);
        if (state?.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        if (state?.fadeTimer) clearInterval(state.fadeTimer);
        if (state?.coverDebounceTimer) clearTimeout(state.coverDebounceTimer);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            controller.unregisterPlayModeCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }

        const animator = this.animators.get(context);
        if (animator) { animator.destroy(context); this.animators.delete(context); }

        marqueeAnimator.destroy(context);
        marqueeAnimator.destroy(cursorMarqueeKey(context));

        this.coverCaches.delete(context);
        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    // Rotate moves a local preview cursor through the cached queue — it never touches live
    // playback (Push commits it later). No-op for radio or an empty/not-yet-loaded queue.
    override async onDialRotate(ev: DialRotateEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        if (state.fadeTimer) return; // ignore input while leaving/entering browse mode
        if (state.playbackKind !== 'queue' || state.queueItems.length === 0) return;

        const wasResting = state.cursorIndex === -1;
        const base = wasResting ? (state.liveTrackIndex >= 0 ? state.liveTrackIndex : 0) : state.cursorIndex;
        state.cursorIndex = wrapIndex(base, ev.payload.ticks, state.queueItems.length);

        // Seed with the already-loaded now-playing cover so the first carousel frame isn't blank
        // while loadCursorCover's fetch is in flight — cheap, and usually exactly right anyway.
        if (wasResting && state.cursorIndex === state.liveTrackIndex && state.trackInfo?.albumArtDataUri) {
            state.cursorCoverUri = state.trackInfo.albumArtDataUri;
        }

        const cursorItem = state.queueItems[state.cursorIndex];
        marqueeAnimator.update(cursorMarqueeKey(context), { text: cursorItem?.Title ?? '', availableWidth: TEXT_WIDTH });
        this.startBrowseTimeout(context);

        // Cache hits apply instantly (no network, cheap on every tick). Actual fetches are
        // debounced — only the position the user finally settles on gets requested, instead of
        // every intermediate tick while scrolling past. See COVER_DEBOUNCE_MS's comment on state.
        const hadCachedCover = this.applyCachedCursorCover(context);
        if (state.coverDebounceTimer) clearTimeout(state.coverDebounceTimer);
        state.coverDebounceTimer = setTimeout(() => {
            const s = this.states.get(context);
            if (!s) return;
            s.coverDebounceTimer = undefined;
            if (!hadCachedCover) void this.loadCursorCover(context);
            void this.prefetchCover(context, s.queueItems[wrapIndex(s.cursorIndex, -1, s.queueItems.length)]);
            void this.prefetchCover(context, s.queueItems[wrapIndex(s.cursorIndex, 1, s.queueItems.length)]);
        }, COVER_DEBOUNCE_MS);

        void this.renderDial(context);
    }

    // Push commits the cursor's selection: jump the actual playback to that queue position, then
    // fade back to the resting view. A no-op while resting (nothing selected to commit) or mid-fade.
    override async onDialDown(ev: DialDownEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        if (!state || !controller) return;
        if (state.cursorIndex === -1 || state.fadeTimer) return;

        const targetIndex = state.cursorIndex;
        this.cancelBrowse(context);

        try {
            await controller.transportDevice.AVTransportService.Seek({
                InstanceID: 0,
                Unit: 'TRACK_NR',
                Target: String(targetIndex + 1),
            });
        } catch (e) {
            streamDeck.logger.warn('Seek (TRACK_NR) failed', e);
        }
    }

    // Touch cancels an active browse without jumping anywhere. A no-op while resting.
    override async onTouchTap(ev: TouchTapEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        if (state.cursorIndex === -1 || state.fadeTimer) return;
        this.cancelBrowse(context);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, QueueDialSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;
                const deviceItems = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- Choose Device --', value: '' }, ...deviceItems]
                });
            }
            if (ev.payload.event === 'get-cover-position-options') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-cover-position-options',
                    items: [
                        { label: piT('Left'), value: 'left' },
                        { label: piT('Right'), value: 'right' },
                    ],
                });
            }
            if (ev.payload.event === 'get-viz-options') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-viz-options',
                    items: [
                        { label: piT('None'), value: 'none' },
                        ...[...effectRegistry.values()].map(def => ({ label: piT(def.displayName), value: def.id })),
                    ],
                });
            }
        }
    }

    protected async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (!sdAction || !sdAction.isDial() || !state || !animator) return;

        const settings = this.settingsMap.get(context);

        if (!settings?.deviceIp) {
            const readySvg = buildUnconfiguredDialSvg('QUEUE');
            const img = `data:image/svg+xml;base64,${Buffer.from(readySvg).toString('base64')}`;
            await sdAction.setFeedback({ 'full-canvas': img, 'title': '', 'indicator': { value: 0, enabled: false } }).catch(() => {});
            return;
        }

        if (state.cursorIndex !== -1 && state.queueItems.length > 0) {
            await this.renderCarousel(sdAction, context, state, settings);
            return;
        }

        const coverOnLeft = settings.coverPosition === 'left';
        const coverX = coverOnLeft ? 0 : 200 - COVER_WIDTH;
        const resolvedTextX = coverOnLeft ? COVER_WIDTH + COVER_TEXT_GAP : OUTER_MARGIN;

        const isPlaying = state.transportState === 'PLAYING';
        const textOpacity = isPlaying ? 1 : 0.6;
        const artist = state.trackInfo?.Artist ?? '';

        let titleFrag = '';
        if (marqueeAnimator.isRunning(context)) {
            titleFrag = marqueeAnimator.render(context, resolvedTextX, 22, TEXT_WIDTH, 20);
        } else {
            const t = this.escapeXml(state.trackInfo?.Title ?? 'Sonos');
            titleFrag = `<text x="${resolvedTextX}" y="22" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="14" clip-path="url(#textClip)">${t}</text>`;
        }

        let statusFrag = '';
        let indicatorValue = 0;
        let indicatorEnabled = false;

        if (state.playbackKind === 'queue' && state.queueItems.length > 0 && state.liveTrackIndex >= 0) {
            const total = state.queueItems.length;
            const position = Math.min(state.liveTrackIndex + 1, total);
            const fraction = position / total;
            indicatorValue = Math.round(fraction * 100);
            indicatorEnabled = true;
            statusFrag = [
                `<rect x="${resolvedTextX}" y="86" width="${TEXT_WIDTH}" height="5" fill="white" opacity="0.12" rx="2.5"/>`,
                `<rect x="${resolvedTextX}" y="86" width="${Math.round(TEXT_WIDTH * fraction)}" height="5" fill="#7A9CFF" opacity="0.9" rx="2.5"/>`,
                `<text x="${resolvedTextX}" y="80" fill="#999999" font-family="Arial,sans-serif" font-size="10">${position}/${total}</text>`,
            ].join('');
        }

        const sharpCover = animator.render(context, coverX, 0, COVER_WIDTH, 100);
        const coverClipX = coverX;

        // Panorama effect (Background PI field) as a full-canvas layer behind the text/cover —
        // same opt-in as Volume/Track/GroupVolume Dial. Falls back to plain black otherwise.
        const rawPanoKey = this.isEffectMode(settings.visualizerMode) ? panoramaContextGroupKey.get(context) : undefined;
        const panoramaKey = isPanoramaEffectActive(rawPanoKey) ? rawPanoKey : undefined;

        let backgroundFrag = '<rect width="200" height="100" fill="black"/>';
        let pillFrags = '';
        if (panoramaKey) {
            const sliceOffset = getPanoramaSliceOffset(context);
            backgroundFrag = `<rect width="200" height="100" fill="#000"/><g clip-path="url(#panoClip)">${renderPanoramaEffectSlice(panoramaKey, sliceOffset)}</g>`;

            // Text pills for legibility against a moving background — same technique Track Dial
            // uses in its own panorama branch.
            const titleText = state.trackInfo?.Title ?? '';
            const titlePillW = titleText ? Math.min(TEXT_WIDTH + 6, this.estimateTextWidth(titleText, 14) + 8) : 0;
            const artistPillW = artist ? Math.min(TEXT_WIDTH + 6, this.estimateTextWidth(artist, 11) + 8) : 0;
            pillFrags = [
                titlePillW > 0 ? `<rect x="${resolvedTextX - 3}" y="11" width="${titlePillW}" height="15" fill="black" opacity="0.55" rx="3"/>` : '',
                artistPillW > 0 ? `<rect x="${resolvedTextX - 3}" y="31" width="${artistPillW}" height="13" fill="black" opacity="0.55" rx="3"/>` : '',
            ].join('');
        }

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            `  <clipPath id="textClip"><rect x="${resolvedTextX}" y="0" width="${TEXT_WIDTH}" height="100"/></clipPath>`,
            `  <clipPath id="coverClip"><rect x="${coverClipX}" y="0" width="${COVER_WIDTH}" height="100" rx="6"/></clipPath>`,
            '  <clipPath id="panoClip"><rect width="200" height="100"/></clipPath>',
            '</defs>',
            backgroundFrag,
            pillFrags,
            `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
            titleFrag,
            `  <text x="${resolvedTextX}" y="40" fill="#999999" font-family="Arial,sans-serif" font-size="11">${this.escapeXml(artist)}</text>`,
            '</g>',
            statusFrag,
            `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
            this.renderFadeOverlay(state),
            '</svg>',
        ].join('');

        const finalImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

        await sdAction.setFeedback({
            'full-canvas': finalImage,
            'icon': '',
            'title': '',
            'indicator': { 'value': indicatorValue, 'enabled': indicatorEnabled },
        }).catch(() => {});
    }

    // 3-row carousel: dimmed prev title (text only) / focused cursor title (large, with cover) /
    // dimmed next title (text only). Only the cursor row's cover is ever fetched — see
    // loadCursorCover — so scrolling quickly never fans out into a burst of image requests. The
    // cover uses the same full-height slot as the resting view (bigger + no crossfade — see
    // cursorCoverUri) rather than a small thumbnail.
    private async renderCarousel(
        sdAction: DialAction<QueueDialSettings>,
        context: string,
        state: QueueDialState,
        settings: QueueDialSettings,
    ): Promise<void> {
        const coverOnLeft = settings.coverPosition === 'left';
        const coverX = coverOnLeft ? 0 : 200 - COVER_WIDTH;
        const resolvedTextX = coverOnLeft ? COVER_WIDTH + COVER_TEXT_GAP : OUTER_MARGIN;

        const total = state.queueItems.length;
        const prevIdx = wrapIndex(state.cursorIndex, -1, total);
        const nextIdx = wrapIndex(state.cursorIndex, 1, total);
        const prevItem = state.queueItems[prevIdx];
        const cursorItem = state.queueItems[state.cursorIndex];
        const nextItem = state.queueItems[nextIdx];

        let cursorTitleFrag: string;
        const cursorKey = cursorMarqueeKey(context);
        if (marqueeAnimator.isRunning(cursorKey)) {
            cursorTitleFrag = marqueeAnimator.render(cursorKey, resolvedTextX, 46, TEXT_WIDTH, 20);
        } else {
            const t = this.escapeXml(cursorItem?.Title ?? '');
            cursorTitleFrag = `<text x="${resolvedTextX}" y="46" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="15" clip-path="url(#carouselTextClip)">${t}</text>`;
        }

        const prevText = this.escapeXml(truncateForDisplay(prevItem?.Title ?? '', 22));
        const nextText = this.escapeXml(truncateForDisplay(nextItem?.Title ?? '', 22));
        const cursorArtist = this.escapeXml(cursorItem?.Artist ?? '');

        const coverFrag = state.cursorCoverUri
            ? `<image href="${state.cursorCoverUri}" x="${coverX}" y="0" width="${COVER_WIDTH}" height="100" preserveAspectRatio="xMidYMid slice"/>`
            : `<rect x="${coverX}" y="0" width="${COVER_WIDTH}" height="100" fill="#111"/>`;

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            `  <clipPath id="carouselTextClip"><rect x="${resolvedTextX}" y="0" width="${TEXT_WIDTH}" height="100"/></clipPath>`,
            `  <clipPath id="cursorCoverClip"><rect x="${coverX}" y="0" width="${COVER_WIDTH}" height="100" rx="6"/></clipPath>`,
            '</defs>',
            '<rect width="200" height="100" fill="black"/>',
            `<text x="${resolvedTextX}" y="14" fill="#AAAAAA" font-family="Arial,sans-serif" font-size="10" opacity="0.5" clip-path="url(#carouselTextClip)">${prevText}</text>`,
            `<g clip-path="url(#carouselTextClip)">${cursorTitleFrag}</g>`,
            `<text x="${resolvedTextX}" y="64" fill="#999999" font-family="Arial,sans-serif" font-size="11" clip-path="url(#carouselTextClip)">${cursorArtist}</text>`,
            `<text x="${resolvedTextX}" y="94" fill="#AAAAAA" font-family="Arial,sans-serif" font-size="10" opacity="0.5" clip-path="url(#carouselTextClip)">${nextText}</text>`,
            `<g clip-path="url(#cursorCoverClip)">${coverFrag}</g>`,
            this.renderFadeOverlay(state),
            '</svg>',
        ].join('');

        const position = state.cursorIndex + 1;
        const fraction = total > 0 ? position / total : 0;

        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
            'icon': '',
            'title': '',
            'indicator': { 'value': Math.round(fraction * 100), 'enabled': true },
        }).catch(() => {});
    }

    private estimateTextWidth(text: string, fontSize: number): number {
        return Math.max(0, Math.ceil(text.length * fontSize * 0.55) + 4);
    }

    private renderFadeOverlay(state: QueueDialState): string {
        return state.fadeOpacity !== undefined
            ? `<rect width="200" height="100" fill="#000" opacity="${state.fadeOpacity.toFixed(3)}"/>`
            : '';
    }

    private escapeXml(unsafe: string): string {
        return unsafe.replace(/[<>&"']/g, (c) => {
            switch (c) {
                case '<': return '&lt;'; case '>': return '&gt;';
                case '&': return '&amp;'; case '"': return '&quot;';
                case "'": return '&apos;'; default: return c;
            }
        });
    }
}
