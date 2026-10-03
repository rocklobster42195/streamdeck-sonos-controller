import streamDeck, {
    action,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    DialRotateEvent,
    DialDownEvent,
    TouchTapEvent,
} from "@elgato/streamdeck";
import { mdiMusicNote, mdiRadio } from "@mdi/js";
import { ListController, type ListRow, nowPlayingCard } from "@rocklobster42195/streamdeck-kit";
import { PanoramaCapableDialAction, PanoramaCapableSettings } from "./PanoramaCapableDialAction";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { Track } from "@svrooij/sonos/lib/models";
import { loadImageFromUri } from "../sonos/cover-art-loader";
import { wrapIndex } from "../sonos/queue-utils";
import { isBrowsableQueue, QueueState, TrackInfo } from "../sonos/SonosTypes";
import { ACCENT_COLOR, buildUnconfiguredDialSvg } from "../utils/icons";
import { QueueCoverArtCache } from "./QueueCoverArtCache";
import { piT } from "../utils/pi-i18n";
import { panoramaContextGroupKey, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive, groupEffects } from "../effects/panorama";
import { ControllerLease } from "./ControllerLease";
import { getDominantColor, ensureVisibleColor } from "../utils/color-extract";

type QueueDialSettings = PanoramaCapableSettings & {
    deviceIp?: string;
    // Which side the cover was drawn on in the old resting view — no longer used (the dial is a
    // list now), kept so stored settings stay as they are.
    coverPosition?: 'left' | 'right';
    queueTimeoutSeconds?: number;
    showCovers?: boolean; // false: icons only in the list
};

interface QueueDialState {
    trackInfo?: TrackInfo;
    transportState: string;
    playbackKind: 'queue' | 'radio' | 'unknown';
    // false while there is no queue worth browsing (another app's stream, a station, a single item)
    queueActive?: boolean;
    queueState?: QueueState;
    queueItems: Track[];
    liveTrackIndex: number; // 0-based; -1 = unknown/not applicable
    dominantColor: string;
    lastColorUri?: string;
    // Which dominantColor value has already been pushed into a live panorama effect — renderDial
    // retries the push on every tick until it lands (the group can finish forming just after the
    // color was extracted, and nothing re-triggers the extraction for an unchanged cover).
    colorPushedFor?: string;
    // AVTransport's LastChange event bundles ALL fields on every fire, so the play-mode callback
    // fires on every track change too — the last value tells a real shuffle/repeat toggle apart.
    lastPlayMode?: string;
    /** The scrolling list (kit): rests on the live track unless the user scrolls. */
    list: ListController;
    browsing: boolean;
    /** The live index the list last followed. */
    followed?: number;
    // Last image sent: the panorama tick calls renderDial ~20x a second, and identical
    // setFeedback calls at that rate overwhelmed the Stream Deck's rendering on hardware.
    lastImage?: string;
    browseTimeoutId?: NodeJS.Timeout;
    browseTimeoutMs: number;
}

/**
 * The queue as the family's scrolling list (as on MA-C's Queue dial): it rests on the playing
 * track and glides along when it changes. Rotate: scroll · Push: play the selected track ·
 * Touch (or the timeout): glide back to the playing track. Radio has no queue: then the dial
 * shows the now-playing card.
 */
@action({ UUID: "de.boriskemper.sonos-controller.queue-dial" })
export class QueueDial extends PanoramaCapableDialAction<QueueDialSettings> {
    protected override panoramaLabel(): string {
        return piT('Queue');
    }

    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private states: Map<string, QueueDialState> = new Map();
    private coverCaches: Map<string, QueueCoverArtCache> = new Map();

    private onTransportStateChanged(context: string, transportState: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.transportState = transportState;
        void this.renderDial(context);
    }

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const state = this.states.get(context);
        if (!state) return;

        // The controller's currentTrack event fires twice per track change: at once with a
        // FALLBACK cover (the previous track's), then again with the real one. Resolve the cover by
        // AlbumArtUri from the cache first, and keep the visible cover when an event has none
        // (e.g. a radio news segment).
        const previous = state.trackInfo;
        const cachedCover = trackInfo.AlbumArtUri ? this.coverCaches.get(context)?.get(trackInfo.AlbumArtUri) : undefined;
        if (cachedCover) {
            trackInfo = { ...trackInfo, albumArtDataUri: cachedCover };
        } else if (!trackInfo.albumArtDataUri && previous?.albumArtDataUri) {
            trackInfo = { ...trackInfo, albumArtDataUri: previous.albumArtDataUri };
        }
        const wasRadio = state.playbackKind === 'radio';
        state.trackInfo = trackInfo;
        state.playbackKind = trackInfo.isRadio ? 'radio' : 'queue';
        if (state.playbackKind === 'radio' && state.browsing) this.stopBrowsing(state);

        // Seed the cache with the cover we already have — NOT while the controller flags it as
        // still pending (a placeholder not confirmed for THIS AlbumArtUri; caching it once filed a
        // radio station's cover under an ABBA album, hardware 2026-07-18).
        if (!trackInfo.coverPending && trackInfo.AlbumArtUri && trackInfo.albumArtDataUri) {
            this.coverCaches.get(context)?.set(trackInfo.AlbumArtUri, trackInfo.albumArtDataUri);
        }
        this.extractDominantColor(context, trackInfo.albumArtDataUri);

        const controller = this.lease.get(context);
        if (controller) {
            // Radio -> queue: fetch the whole queue; otherwise only the cheap live position
            void this.refreshQueueContext(context, controller, wasRadio && state.playbackKind === 'queue');
        }
        void this.renderDial(context);
    }

    // The queue was replaced (new id, e.g. by Music Assistant), changed its length, or the speaker
    // left it: reload what we show, or show nothing but the effect while there is no real queue.
    private onQueueStateChanged(context: string, qs: QueueState): void {
        const state = this.states.get(context);
        if (!state) return;
        state.queueState = qs;
        state.queueActive = isBrowsableQueue(qs);
        if (!state.queueActive && state.browsing) this.stopBrowsing(state);
        const controller = this.lease.get(context);
        if (state.queueActive && controller) void this.refreshQueueContext(context, controller, true);
        void this.renderDial(context);
    }

    // Shuffle/repeat toggles (from anywhere) can reorder the queue — refetch it. This callback
    // fires on every AVTransport LastChange, not only on real toggles; without the lastPlayMode
    // check every track change pulled the whole queue and delayed the track's own cover/title
    // update by 10+ s (the speaker's connections are few).
    private onPlayModeChanged(context: string, playMode: string): void {
        const state = this.states.get(context);
        const controller = this.lease.get(context);
        if (!state || !controller) return;
        if (state.lastPlayMode === playMode) return;
        state.lastPlayMode = playMode;
        if (state.browsing || state.playbackKind !== 'queue') return;
        void this.refreshQueueContext(context, controller, true);
    }

    // Keeps queueItems/liveTrackIndex in sync. `fullRefetch` re-pulls the whole queue (radio->queue,
    // a shuffle/repeat toggle, first load); otherwise only the position lookup runs.
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
        // Warm the cache for the live track's neighbours, so the first turn finds them
        if (state.liveTrackIndex >= 0 && state.queueItems.length > 1) {
            for (const offset of [-1, 1, -2, 2]) {
                void this.prefetchCover(context, state.queueItems[wrapIndex(state.liveTrackIndex, offset, state.queueItems.length)], true);
            }
        }
        void this.renderDial(context);
    }

    private stopBrowsing(state: QueueDialState): void {
        state.browsing = false;
        if (state.browseTimeoutId) { clearTimeout(state.browseTimeoutId); state.browseTimeoutId = undefined; }
    }

    /** Touch, the timeout, after a push: glide back to the playing track. */
    private backToLive(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
        this.stopBrowsing(state);
        if (state.liveTrackIndex >= 0) state.list.moveTo(state.liveTrackIndex);
        state.followed = state.liveTrackIndex;
    }

    // queueTimeoutSeconds === 0 disables the auto-return — browsing then ends only via Touch or Push.
    private startBrowseTimeout(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        if (state.browseTimeoutMs <= 0) return;
        state.browseTimeoutId = setTimeout(() => {
            const s = this.states.get(context);
            if (s) s.browseTimeoutId = undefined;
            this.backToLive(context);
        }, state.browseTimeoutMs);
    }

    // Warms the cache for one queue item; `redraw` repaints once it arrived.
    private async prefetchCover(context: string, item: Track | undefined, redraw = false): Promise<void> {
        const controller = this.lease.get(context);
        const cache = this.coverCaches.get(context);
        if (!controller || !cache || !item?.AlbumArtUri) return;
        const key = item.AlbumArtUri ?? item.TrackUri ?? '';
        if (!key || cache.has(key)) return;
        try {
            const dataUri = await loadImageFromUri(item.AlbumArtUri, controller.transportDevice);
            if (dataUri) {
                cache.set(key, dataUri);
                if (redraw) void this.renderDial(context);
            }
        } catch { /* best effort — the next rest retries */ }
    }

    protected hasLiveInstance(context: string): boolean {
        return this.lease.has(context);
    }

    protected override async onInstanceUpdate(ev: WillAppearEvent<QueueDialSettings> | DidReceiveSettingsEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        let settings = ev.payload.settings;

        this.cleanupInstance(context);

        settings = this.applyBackfill(ev, settings, { coverPosition: 'right', queueTimeoutSeconds: 5 });

        const { deviceIp } = settings;
        this.settingsMap.set(context, settings);
        this.coverCaches.set(context, new QueueCoverArtCache());

        this.states.set(context, {
            transportState: 'STOPPED',
            playbackKind: 'unknown',
            queueItems: [],
            liveTrackIndex: -1,
            dominantColor: '#CCCCCC',
            list: new ListController({ id: context, redraw: () => void this.renderDial(context) }),
            browsing: false,
            browseTimeoutMs: (settings.queueTimeoutSeconds ?? 5) * 1000,
        });

        this.syncPanoramaParticipation(context, settings);

        await this.renderDial(context);

        if (!deviceIp) return;

        try {
            let wasReachable = false;
            const controller = await this.lease.acquire(context, deviceIp, (controller) => {
                wasReachable = this.registerReachabilityHandling(controller, ev, piT('Queue').toUpperCase());
                if (wasReachable) {
                    controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
                    // Fires immediately with cached state (incl. isRadio) if a track is already known.
                    controller.registerTrackInfoCallback(context, (ti) => this.onTrackInfoChanged(context, ti));
                    controller.registerPlayModeCallback(context, (pm) => this.onPlayModeChanged(context, pm));
                    controller.registerQueueStateCallback(context, (qs) => this.onQueueStateChanged(context, qs));
                }
                return [
                    () => controller.unregisterTransportStateCallback(context),
                    () => controller.unregisterTrackInfoCallback(context),
                    () => controller.unregisterPlayModeCallback(context),
                    () => controller.unregisterQueueStateCallback(context),
                    () => controller.unregisterReachabilityCallback(context),
                ];
            });

            if (!wasReachable) return;
            // Past the bail-out above the controller believes it's reachable — clear a stale flag a
            // previous failed setup left behind, or renderDial()'s guard would keep no-op'ing.
            this.unreachableContexts.delete(context);

            const [transportState, track, playMode] = await Promise.all([
                controller.getTransportState(),
                controller.getCurrentTrack(),
                controller.getPlayMode(),
            ]);

            const state = this.states.get(context)!;
            state.transportState = transportState;
            if (track && !state.trackInfo) state.trackInfo = track;
            // Seed the baseline so the first LastChange doesn't look like a toggle (extra getQueue)
            state.lastPlayMode = playMode;

            // For radio, getCurrentTrack() returns undefined; the cover comes from the stream URI.
            const cover = await controller.getCurrentTrackCover();
            if (cover) {
                if (!state.trackInfo) state.trackInfo = {} as TrackInfo;
                state.trackInfo.albumArtDataUri = cover;
                this.extractDominantColor(context, cover);
            }

            if (state.playbackKind === 'queue') {
                await this.refreshQueueContext(context, controller, true);
            }

            await this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
            await this.renderUnreachableDial(context, piT('Queue').toUpperCase());
            this.scheduleSetupRetry(ev);
        }
    }

    protected cleanupInstance(context: string): void {
        const state = this.states.get(context);
        if (state?.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state?.list.dispose();
        this.lease.release(context);
        this.coverCaches.delete(context);
        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    // Rotate scrolls the list — it never touches live playback (Push does). No-op for radio or an
    // empty/not-yet-loaded queue.
    override async onDialRotate(ev: DialRotateEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        if (state.playbackKind !== 'queue' || state.queueItems.length === 0 || state.queueActive === false) return;
        state.browsing = true;
        state.list.setLength(state.queueItems.length);
        state.list.rotate(ev.payload.ticks);
        this.startBrowseTimeout(context);
    }

    // Push plays the marked track (a jump in the queue). A no-op while not browsing.
    override async onDialDown(ev: DialDownEvent<QueueDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.lease.get(context);
        if (!state || !controller || !state.browsing) return;

        const targetIndex = state.list.marked;
        const targetItem = state.queueItems[targetIndex];
        // We already know which track becomes current: show it as playing right away instead of
        // the old one until the Seek/UPnP round-trip completes.
        if (targetItem) {
            const cover = targetItem.AlbumArtUri ? this.coverCaches.get(context)?.get(targetItem.AlbumArtUri) : undefined;
            state.trackInfo = { ...targetItem, albumArtDataUri: cover ?? state.trackInfo?.albumArtDataUri, isRadio: false };
            state.liveTrackIndex = targetIndex;
            this.extractDominantColor(context, cover);
        }
        this.backToLive(context);
        void this.renderDial(context);

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

    // Touch glides back to the playing track.
    override async onTouchTap(ev: TouchTapEvent<QueueDialSettings>): Promise<void> {
        this.backToLive(ev.action.id);
    }

    protected async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        if (!sdAction || !sdAction.isDial() || !state) return;
        // The panorama tick keeps calling renderDial while the speaker is unreachable — repaint the
        // placeholder (it also self-heals the effect overlay once the panorama group has formed).
        if (this.unreachableContexts.has(context)) {
            void this.renderUnreachableDial(context, piT('Queue').toUpperCase());
            return;
        }

        const settings = this.settingsMap.get(context);
        if (!settings?.deviceIp) {
            const readySvg = buildUnconfiguredDialSvg(piT('Queue').toUpperCase());
            const img = `data:image/svg+xml;base64,${Buffer.from(readySvg).toString('base64')}`;
            await sdAction.setFeedback({ 'full-canvas': img, 'title': '', 'indicator': { value: 0, enabled: false } }).catch(() => {});
            return;
        }

        const backdrop = this.effectBackdrop(context, settings, state);
        let image: string;
        let indicator = { value: 0, enabled: false };
        const total = state.queueItems.length;
        if (state.queueActive === false) {
            // The speaker doesn't play from its queue (another app streams to it, or a station):
            // nothing to show but the row's effect
            image = `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#0a0a0a"/>${backdrop ? panoramaContextGroupKey.get(context) ? renderPanoramaEffectSlice(panoramaContextGroupKey.get(context)) : '' : ''}</svg>`).toString('base64')}`;
        } else if (state.playbackKind === 'queue' && total > 0) {
            if (!state.list.length) {
                state.list.reset(total, Math.max(0, state.liveTrackIndex));
                state.followed = state.liveTrackIndex;
            } else if (state.list.length !== total) {
                state.list.setLength(total);
            }
            // The track changed while nobody scrolls: glide along (after this render, not inside it)
            if (!state.browsing && state.liveTrackIndex >= 0 && state.followed !== state.liveTrackIndex) {
                state.followed = state.liveTrackIndex;
                const to = state.liveTrackIndex;
                queueMicrotask(() => state.list.moveTo(to));
            }
            const resting = !state.list.model.moving;
            image = state.list.render({
                row: (i) => this.listRow(context, state, i, resting),
                accent: ACCENT_COLOR,
                showImages: settings.showCovers !== false,
                backdrop,
            });
            indicator = { value: Math.round(((state.list.marked + 1) / total) * 100), enabled: true };
        } else {
            // Radio (no queue to browse) or nothing loaded yet: the now-playing card
            if (state.list.length) state.list.reset(0);
            const t = state.trackInfo;
            image = nowPlayingCard({
                cover: t?.albumArtDataUri,
                placeholderIcon: state.playbackKind === 'radio' ? mdiRadio : mdiMusicNote,
                title: t?.Title || piT('Nothing playing'),
                artist: t?.Artist || undefined,
                hint: state.playbackKind === 'radio' ? piT('Radio') : '',
                backdrop,
            });
        }

        if (image === state.lastImage) return;
        state.lastImage = image;
        await sdAction.setFeedback({ 'full-canvas': image, 'icon': '', 'title': '', 'indicator': indicator }).catch(() => {});
    }

    private listRow(context: string, state: QueueDialState, i: number, fetchCovers: boolean): ListRow | undefined {
        const item = state.queueItems[i];
        if (!item) return undefined;
        const key = item.AlbumArtUri ?? item.TrackUri ?? '';
        const cover = key ? this.coverCaches.get(context)?.get(key) : undefined;
        // Missing covers are fetched only while the list rests, so fast scrolling never fans out
        // into a burst of requests at the speaker's small web server
        if (!cover && fetchCovers && item.AlbumArtUri) void this.prefetchCover(context, item, true);
        return { title: item.Title ?? '', subtitle: item.Artist || undefined, image: cover, icon: mdiMusicNote, active: i === state.liveTrackIndex };
    }

    /** The row's Panorama effect under the dial, darkened for the text ('' without one); also feeds it the cover's colour. */
    private effectBackdrop(context: string, settings: QueueDialSettings, state: QueueDialState): string {
        const key = panoramaContextGroupKey.get(context);
        if (!isPanoramaEffectActive(key)) return '';
        // Retried on every render until it lands — see colorPushedFor
        if (state.colorPushedFor !== state.dominantColor) {
            groupEffects.get(key!)?.onSettingsChange?.({ color: ensureVisibleColor(state.dominantColor) });
            state.colorPushedFor = state.dominantColor;
        }
        return renderPanoramaEffectSlice(key!, getPanoramaSliceOffset(context)) + '<rect width="200" height="100" fill="#000" opacity="0.45"/>';
    }

    // Extracts the cover's dominant colour (async) and stores it; effectBackdrop feeds it into a
    // live panorama effect.
    private extractDominantColor(context: string, cover: string | undefined): void {
        const state = this.states.get(context);
        if (!state || !cover || cover === state.lastColorUri) return;
        state.lastColorUri = cover;
        getDominantColor(cover).then(color => {
            const s = this.states.get(context);
            if (!s) return;
            s.dominantColor = color;
            void this.renderDial(context);
        }).catch(() => {});
    }
}
