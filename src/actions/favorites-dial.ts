import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    DialDownEvent,
    DidReceiveSettingsEvent,
    TouchTapEvent
} from "@elgato/streamdeck";
import { PanoramaCapableDialAction, PanoramaCapableSettings } from "./PanoramaCapableDialAction";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosFavoritesCache } from "../sonos/sonos-discovery";
import { PlaybackSource, SonosFavorite, TrackInfo, VolumeInfo } from "../sonos/SonosTypes";
import { mdiCog, mdiHeart, mdiHeartCircle, mdiHeartCircleOutline, mdiAudioInputRca } from "@mdi/js";
import { ListController, type ListRow, nowPlayingCard } from "@rocklobster42195/streamdeck-kit";
import { ACCENT_COLOR, INACTIVE_ICON_COLOR } from "../utils/icons";
import { piT } from "../utils/pi-i18n";
import { escapeXml } from "../utils/xml";
import { deviceHasLineIn } from "../sonos/SonosLineIn";
import { syncCapabilityFlag } from "./capability-flag";
import { panoramaContextGroupKey, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive } from "../effects/panorama";
import { ControllerLease } from "./ControllerLease";

type FavoritesDialSettings = PanoramaCapableSettings & {
    deviceIp?: string;
    browseTimeout?: number; // seconds before returning to now-playing, default 3
    fadeDuration?: string;  // seconds as string from the PI select, "0"/undefined = no fade
    align?: 'left' | 'center' | 'right'; // heart icon position in icon mode, default 'center'
    // visualizerMode ('mosaic' | any registered effect id) comes from PanoramaCapableSettings.
    // 'mosaic' is the non-effect baseline (today's cover-mosaic/now-playing look); any effect id
    // switches idle + now-playing to a full-canvas effect background with a centered heart icon.
    includeLineIn?: boolean; // user opt-in, PI checkbox only offered when hasLineIn is true
    showCovers?: boolean; // false: icons only in the browsing list
    // Computed on every settings sync (see onInstanceUpdate) and written back via setSettings() so
    // the PI can react through the settings-sync channel (hidden <sdpi-checkbox setting="hasLineIn">,
    // see battery-capability.js's wireBatteryCapability — generic despite the name, reused here) to
    // only offer the "Append Line-In" checkbox for devices that actually have the input.
    hasLineIn?: boolean;
};

interface FavDialState {
    currentIndex: number;   // -1 = now-playing mode; otherwise browsing (the list's marked row is the selection)
    list: ListController;   // the browsing list (kit)
    browseTimeoutId?: NodeJS.Timeout;
    browseTimeoutMs: number;
    volume: number;
    isMuted: boolean;
    transportState: string;
    currentTrack?: TrackInfo;
    source?: PlaybackSource; // what the music was started from, when Sonos reports it
    playingFav?: { Title: string; AlbumArtUri?: string; isLineIn?: boolean };
    fadeOpacity?: number;       // black overlay opacity (1=fully black, 0=gone), undefined=no fade
    fadeTimer?: NodeJS.Timeout;
}

@action({ UUID: "de.boriskemper.sonos-controller.favorites-dial" })
export class FavoritesDial extends PanoramaCapableDialAction<FavoritesDialSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private states: Map<string, FavDialState> = new Map();
    private renderGen: Map<string, number> = new Map();
    // Whether the currently configured device has a physical Line-In input — resolved
    // asynchronously (see onInstanceUpdate), not yet known defaults to false (no synthetic entry
    // until proven present, rather than briefly showing then possibly retracting it).
    private hasLineInByContext: Map<string, boolean> = new Map();

    // 'mosaic' is this dial's non-effect baseline (like TrackDial's 'none'/'eq') — everything else
    // is a registered effect id.
    protected override isEffectMode(mode?: string): boolean {
        return !!mode && mode !== 'mosaic';
    }

    // Batch rapid state changes into a single render — only the latest gen fires.
    private queueRender(context: string): void {
        const gen = (this.renderGen.get(context) ?? 0) + 1;
        this.renderGen.set(context, gen);
        setImmediate(() => {
            if (this.renderGen.get(context) !== gen) return;
            void this.renderDial(context);
        });
    }

    // Synthetic, non-persisted "favorite" appended when the configured device has a Line-In
    // input — not a real Sonos favorite, recognized downstream purely via the isLineIn flag.
    // Title reuses the same "Line-In" i18n key already added for MultiControlKey.
    private lineInEntry(): SonosFavorite {
        return { Title: piT('Line-In'), TrackUri: '', AlbumArtUri: '', isLineIn: true };
    }

    private getFavorites(context: string): SonosFavorite[] {
        const favs = sonosFavoritesCache.getFavorites() ?? [];
        const settings = this.settingsMap.get(context);
        const shouldInclude = this.hasLineInByContext.get(context) && settings?.includeLineIn;
        return shouldInclude ? [...favs, this.lineInEntry()] : favs;
    }

    private onVolumeInfoChanged(context: string, vol: VolumeInfo): void {
        const state = this.states.get(context);
        if (!state) return;
        state.volume = vol.volume;
        state.isMuted = vol.mute;
        this.queueRender(context);
    }

    private onTransportStateChanged(context: string, ts: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.transportState = ts;
        this.queueRender(context);
    }

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const state = this.states.get(context);
        if (!state) return;
        if (!trackInfo.albumArtDataUri && state.currentTrack?.albumArtDataUri) {
            trackInfo = { ...trackInfo, albumArtDataUri: state.currentTrack.albumArtDataUri };
        }
        state.currentTrack = trackInfo;

        this.matchPlayingFavorite(context, state);

        this.queueRender(context);
    }

    private onSourceChanged(context: string, source: PlaybackSource | undefined): void {
        const state = this.states.get(context);
        if (!state) return;
        state.source = source;
        this.matchPlayingFavorite(context, state);
        this.queueRender(context);
    }

    // The playing favorite: the one the music was started from (Sonos's source — by its id at the
    // music service, then by name), else one named like the current track or artist (stations
    // report their name there).
    private matchPlayingFavorite(context: string, state: FavDialState): void {
        const favs = this.getFavorites(context);
        const t = state.currentTrack;
        const src = state.source;
        const match = (src?.objectId && favs.find((f) => favoriteMentions(f, src.objectId!)))
            ?? (src && favs.find((f) => f.Title === src.title))
            ?? favs.find((f) => !!f.Title && (f.Title === t?.Title || f.Title === t?.Artist));
        if (match) state.playingFav = { Title: match.Title, AlbumArtUri: match.AlbumArtUri, isLineIn: match.isLineIn };
        else if (!state.playingFav?.isLineIn) state.playingFav = undefined;
    }

    private startBrowseTimeout(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state.browseTimeoutId = setTimeout(() => {
            const s = this.states.get(context);
            if (!s) return;
            s.browseTimeoutId = undefined;
            this.startFadeThroughBlack(context);
        }, state.browseTimeoutMs);
    }

    // Two-phase fade: browse fades to black, then mosaic/now-playing fades in from black.
    private startFadeThroughBlack(context: string): void {
        const state = this.states.get(context);
        if (!state) return;
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
                    // Fully black: switch to now-playing/mosaic
                    phase = 2;
                    step = 0;
                    s.currentIndex = -1;
                    s.list.dispose();
                    s.fadeOpacity = 1.0;
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

    protected hasLiveInstance(context: string): boolean {
        return this.lease.has(context);
    }

    protected override async onInstanceUpdate(ev: WillAppearEvent<FavoritesDialSettings> | DidReceiveSettingsEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        let settings = ev.payload.settings;

        // Preserve browse position (and last-known playback state) across a settings-only update.
        const existing = this.states.get(context);
        this.cleanupInstance(context);

        settings = this.applyBackfill(ev, settings, { visualizerMode: 'mosaic', align: 'center' });
        this.settingsMap.set(context, settings);

        const browseTimeoutMs = (settings.browseTimeout ?? 3) * 1000;

        this.states.set(context, {
            currentIndex: existing?.currentIndex ?? -1,
            list: existing?.list ?? new ListController({ id: context, redraw: () => this.queueRender(context) }),
            browseTimeoutMs,
            volume: existing?.volume ?? 0,
            isMuted: existing?.isMuted ?? false,
            transportState: existing?.transportState ?? 'STOPPED',
            currentTrack: existing?.currentTrack,
            source: existing?.source,
            playingFav: existing?.playingFav,
        });

        this.syncPanoramaParticipation(context, settings);

        // Fire-and-forget: resolves after the first render either way, re-renders once known so
        // the synthetic Line-In entry appears a moment later rather than blocking initial paint.
        // Also written back to settings (dedup-guarded, same pattern as MultiControlKey's
        // hasBattery) so the PI's hidden hasLineIn checkbox can gate the "Append Line-In" field.
        if (settings.deviceIp) {
            void deviceHasLineIn(settings.deviceIp).then(async (hasLineInResult) => {
                if (!this.states.has(context)) return; // instance gone by the time this resolves
                // undefined means "couldn't determine right now" (device temporarily unreachable)
                // — leave whatever was last known alone rather than writing a false negative that
                // would hide the "Append Line-In" checkbox for a device that just happens to be
                // asleep (see deviceHasLineIn's own doc comment for the hardware case this fixes).
                if (hasLineInResult === undefined) return;
                this.hasLineInByContext.set(context, hasLineInResult);
                const current = this.settingsMap.get(context);
                const action = streamDeck.actions.getActionById(context);
                if (current && action) {
                    this.settingsMap.set(context, await syncCapabilityFlag(action, current, 'hasLineIn', hasLineInResult));
                }
                this.queueRender(context);
            }).catch((e) => streamDeck.logger.warn(`[FavDial ${context}] Line-In capability check failed`, e));
        }

        await this.renderDial(context);

        if (!settings.deviceIp) return;

        try {
            let wasReachable = false;
            const controller = await this.lease.acquire(context, settings.deviceIp, (controller) => {
                wasReachable = this.registerReachabilityHandling(controller, ev, piT('Favorites').toUpperCase());
                if (wasReachable) {
                    controller.registerVolumeCallback(context, (vol) => this.onVolumeInfoChanged(context, vol));
                    controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
                    controller.registerTrackInfoCallback(context, (ti) => this.onTrackInfoChanged(context, ti));
                    controller.registerSourceCallback(context, (src) => this.onSourceChanged(context, src));
                }
                return [
                    () => controller.unregisterVolumeCallback(context),
                    () => controller.unregisterTransportStateCallback(context),
                    () => controller.unregisterTrackInfoCallback(context),
                    () => controller.unregisterSourceCallback(context),
                    () => controller.unregisterReachabilityCallback(context),
                ];
            });

            if (!wasReachable) return;
            // We're past the bail-out above, so the controller currently believes it's reachable —
            // clear any stale flag a previous failed setup attempt (see the catch block below) left
            // behind, or renderDial()'s guard would keep no-op'ing forever.
            this.unreachableContexts.delete(context);

            const [vol, ts] = await Promise.all([
                controller.getVolume(),
                controller.getTransportState(),
            ]);

            const state = this.states.get(context)!;
            state.volume = vol.volume;
            state.isMuted = vol.mute;
            state.transportState = ts;

            const cover = await controller.getCurrentTrackCover();
            const track = await controller.getCurrentTrack();
            if (track) {
                state.currentTrack = { ...track, albumArtDataUri: cover };
            } else if (cover) {
                state.currentTrack = { albumArtDataUri: cover } as TrackInfo;
            }

            this.matchPlayingFavorite(context, state);

            await this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`[FavDial ${context}] Setup error:`, e);
            await this.renderUnreachableDial(context, piT('Favorites').toUpperCase());
            this.scheduleSetupRetry(ev);
        }
    }

    protected cleanupInstance(context: string): void {
        const state = this.states.get(context);
        if (state?.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        if (state?.fadeTimer) clearInterval(state.fadeTimer);
        state?.list.dispose();

        this.lease.release(context);

        this.renderGen.delete(context);
        this.settingsMap.delete(context);
        this.states.delete(context);
        this.hasLineInByContext.delete(context);
    }

    override async onDialRotate(ev: DialRotateEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const favs = this.getFavorites(context);
        if (!state || favs.length === 0) return;

        if (state.fadeTimer) {
            clearInterval(state.fadeTimer);
            state.fadeTimer = undefined;
            state.fadeOpacity = undefined;
        }

        if (state.currentIndex === -1) {
            // First rotation: open the list on the playing favorite, or at the top.
            const playing = state.playingFav?.Title ?? state.currentTrack?.Title ?? '';
            const matchIdx = favs.findIndex((f) => f.Title === playing);
            state.currentIndex = matchIdx !== -1 ? matchIdx : 0;
            state.list.reset(favs.length, state.currentIndex);
        } else {
            state.list.setLength(favs.length);
            state.list.rotate(ev.payload.ticks);
            state.currentIndex = state.list.index;
        }

        this.startBrowseTimeout(context);
        this.queueRender(context);
    }

    override async onDialDown(ev: DialDownEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.lease.get(context);
        const favs = this.getFavorites(context);
        if (!state || !controller || state.currentIndex === -1 || favs.length === 0) return;

        const fav = favs[state.list.marked];
        if (!fav) return;

        // Switch the dial back to now-playing right away — with a fade the actual track change
        // takes seconds, and the display shouldn't sit in browse mode until it finishes.
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state.currentIndex = -1;
        state.list.dispose();
        state.browseTimeoutId = undefined;
        state.playingFav = { Title: fav.Title, AlbumArtUri: fav.AlbumArtUri, isLineIn: fav.isLineIn };
        this.queueRender(context);

        const fadeMs = (Number(ev.payload.settings.fadeDuration) || 0) * 1000;
        try {
            if (fav.isLineIn) {
                await controller.switchToLineInWithFade(fadeMs);
            } else if (fadeMs > 0) {
                await controller.playFavoriteWithFade(fav, fadeMs);
            } else {
                await controller.playFavorite(fav);
            }
        } catch (e) {
            streamDeck.logger.error(`[FavDial] Error playing favorite "${fav.Title}":`, e);
        }
    }

    override async onTouchTap(ev: TouchTapEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state.browseTimeoutId = undefined;
        if (state.currentIndex !== -1) {
            this.startFadeThroughBlack(context);
        } else {
            this.queueRender(context);
        }
    }

    protected async renderDial(context: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        if (!action || !action.isDial() || !state) return;
        // The panorama tick's shared render callback keeps firing on the normal ~50-100ms
        // cadence regardless of reachability (going unreachable doesn't leave the panorama
        // group) — without this, it repaints straight over the unreachable placeholder that
        // registerReachabilityHandling just set, within one tick. Re-render (not just bail)
        // because registerInPanorama's group-key assignment is itself debounced ~60ms behind
        // registration (see PanoramaOrchestrator.requestSync) — the very first
        // renderUnreachableDial call can land before that debounce fires and see no active
        // effect group yet, permanently missing the effect overlay otherwise. Re-checking on
        // every tick self-heals within one cycle once the group actually forms.
        if (this.unreachableContexts.has(context)) {
            void this.renderUnreachableDial(context, piT('Favorites').toUpperCase());
            return;
        }

        const settings = this.settingsMap.get(context);
        const favs = this.getFavorites(context);
        const fadeOverlay = state.fadeOpacity !== undefined
            ? `<rect width="200" height="100" fill="#000" opacity="${state.fadeOpacity.toFixed(3)}"/>`
            : '';
        const send = (img: string) => action.setFeedback({ 'full-canvas': fadeOverlay ? withOverlay(img, fadeOverlay) : img }).catch(() => {});

        // Browsing: the kit's scrolling list (marked row in the middle, playing favorite in Sage)
        if (state.currentIndex !== -1 && favs.length > 0) {
            await send(state.list.render({
                row: (i) => this.listRow(favs[i], state.playingFav?.Title),
                accent: ACCENT_COLOR,
                showImages: settings?.showCovers !== false,
            }));
            return;
        }

        if (!settings?.deviceIp) {
            await send(noDeviceStrip());
            return;
        }

        // Idle: the family's now-playing card (as on MA-C's Browser dial) with what the music was
        // started from — the playing favorite, else the playlist/album/station Sonos reports — over
        // the row's Panorama effect when there is one. Nothing known (e.g. a stream Music Assistant
        // sends to the speaker): the heart, filled while playing.
        const fav = state.playingFav;
        const source = state.source;
        if (!fav && !source) {
            // The heart needs no darkening behind it, unlike the card's text
            await send(heartStrip(state.transportState === 'PLAYING', settings.align ?? 'center', this.effectBackdrop(context, settings, false)));
            return;
        }
        const backdrop = this.effectBackdrop(context, settings);
        const track = state.currentTrack;
        const trackLine = [track?.Title, track?.Artist].filter(Boolean).join(' · ');
        const cover = (fav?.AlbumArtUri ? sonosFavoritesCache.getCoverArt(fav.AlbumArtUri) : undefined)
            ?? (fav?.isLineIn ? undefined : track?.albumArtDataUri);
        await send(nowPlayingCard({
            cover,
            placeholderIcon: fav?.isLineIn ? mdiAudioInputRca : mdiHeart,
            title: track?.Title || piT('Nothing playing'),
            source: fav
                ? { kind: piT('Favorite'), name: fav.Title, track: trackLine }
                : { kind: [sourceKind(source!.upnpClass), source!.service].filter(Boolean).join(' · '), name: source!.title, track: trackLine },
            hint: piT('Rotate to browse'),
            backdrop,
        }));
    }

    /** The row's Panorama effect under this dial, darkened (`dim`) so text stays readable ('' without one). */
    private effectBackdrop(context: string, settings: FavoritesDialSettings, dim = true): string {
        const key = panoramaContextGroupKey.get(context);
        if (!isPanoramaEffectActive(key)) return '';
        const slice = renderPanoramaEffectSlice(key!, getPanoramaSliceOffset(context));
        return dim ? slice + '<rect width="200" height="100" fill="#000" opacity="0.45"/>' : slice;
    }

    private listRow(fav: SonosFavorite | undefined, playingTitle: string | undefined): ListRow | undefined {
        if (!fav) return undefined;
        return {
            title: fav.Title ?? '',
            image: fav.AlbumArtUri ? sonosFavoritesCache.getCoverArt(fav.AlbumArtUri) : undefined,
            icon: fav.isLineIn ? mdiAudioInputRca : mdiHeart,
            active: !!playingTitle && fav.Title === playingTitle,
        };
    }
}

/** Does a Sonos favorite point at this container id (e.g. "spotify:playlist:…")? */
function favoriteMentions(fav: SonosFavorite, objectId: string): boolean {
    const id = objectId.toLowerCase();
    return [fav.TrackUri, fav.ResMD, fav.ItemId].some((v) => {
        if (typeof v !== 'string' || !v) return false;
        let text = v;
        try { text = decodeURIComponent(v); } catch { /* keep as is */ }
        return text.toLowerCase().includes(id);
    });
}

/** The kind of a source for the card's first line (from its UPnP class). */
function sourceKind(upnpClass: string | undefined): string {
    const c = upnpClass ?? '';
    if (c.includes('playlistContainer')) return piT('Playlist');
    if (c.includes('album')) return piT('Album');
    if (c.includes('audioBroadcast') || c.includes('radio')) return piT('Radio');
    return piT('Playing from');
}

/**
 * The heart view, when nothing is known about what plays: filled while playing, an outline
 * otherwise, at `align`, over the row's effect (or dark).
 */
function heartStrip(isPlaying: boolean, align: 'left' | 'center' | 'right', backdrop: string): string {
    const cx = align === 'left' ? 50 : align === 'right' ? 150 : 100;
    // mdiHeartCircle's own ring spans 20 of its 24 viewBox units — scale the box so the ring is
    // 76 px across, like the Volume dial's pie
    const size = Math.round(76 * (24 / 20));
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        backdrop
            ? `<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs><rect width="200" height="100" fill="#000"/><g clip-path="url(#c)">${backdrop}</g>`
            : '<rect width="200" height="100" fill="#0a0a0a"/>',
        `<g transform="translate(${cx - size / 2},${50 - size / 2}) scale(${(size / 24).toFixed(3)})"><path fill="#CCCCCC" d="${isPlaying ? mdiHeartCircle : mdiHeartCircleOutline}"/></g>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** No device chosen yet: the cog and a hint. */
function noDeviceStrip(): string {
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        '<rect width="200" height="100" fill="#111"/>',
        `<g transform="translate(82,14) scale(1.5)"><path fill="${INACTIVE_ICON_COLOR}" d="${mdiCog}"/></g>`,
        `<text x="100" y="66" fill="#555555" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">${escapeXml(piT('No device set'))}</text>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/** Lay an SVG fragment (the fade-through-black overlay) over a strip image (an SVG data URI). */
function withOverlay(dataUri: string, fragment: string): string {
    const svg = Buffer.from(dataUri.split(',')[1], 'base64').toString().replace(/<\/svg>$/, `${fragment}</svg>`);
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}
