import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    DialDownEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    TouchTapEvent
} from "@elgato/streamdeck";
import { PanoramaCapableDialAction, PanoramaCapableSettings } from "./PanoramaCapableDialAction";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise, sonosFavoritesCache } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { TrackInfo, VolumeInfo } from "../sonos/SonosTypes";
import { marqueeAnimator } from "../utils/MarqueeAnimator";
import { mdiCog, mdiHeartCircle, mdiHeartCircleOutline } from "@mdi/js";
import { INACTIVE_ICON_COLOR } from "../utils/icons";
import { piT } from "../utils/pi-i18n";
import { panoramaContextGroupKey, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive } from "../effects/PanoramaOrchestrator";
import { effectRegistry } from "../effects/registry.generated";

type FavoritesDialSettings = PanoramaCapableSettings & {
    deviceIp?: string;
    browseTimeout?: number; // seconds before returning to now-playing, default 3
    fadeDuration?: string;  // seconds as string from the PI select, "0"/undefined = no fade
    align?: 'left' | 'center' | 'right'; // heart icon position in icon mode, default 'center'
    // visualizerMode ('mosaic' | any registered effect id) comes from PanoramaCapableSettings.
    // 'mosaic' is the non-effect baseline (today's cover-mosaic/now-playing look); any effect id
    // switches idle + now-playing to a full-canvas effect background with a centered heart icon.
};

interface FavDialState {
    currentIndex: number;   // -1 = now-playing mode
    browseTimeoutId?: NodeJS.Timeout;
    browseTimeoutMs: number;
    volume: number;
    isMuted: boolean;
    transportState: string;
    currentTrack?: TrackInfo;
    playingFav?: { Title: string; AlbumArtUri?: string };
    fadeOpacity?: number;       // black overlay opacity (1=fully black, 0=gone), undefined=no fade
    fadeTimer?: NodeJS.Timeout;
}

@action({ UUID: "de.boriskemper.sonos-controller.favorites-dial" })
export class FavoritesDial extends PanoramaCapableDialAction<FavoritesDialSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, FavDialState> = new Map();
    private renderGen: Map<string, number> = new Map();

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

    private getFavorites(): any[] {
        return sonosFavoritesCache.getFavorites() ?? [];
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

        const favs = this.getFavorites();
        const match = favs.find((f: any) => f.Title === trackInfo.Title || f.Title === trackInfo.Artist);
        state.playingFav = match ? { Title: match.Title, AlbumArtUri: match.AlbumArtUri } : undefined;

        if (state.currentIndex === -1) {
            marqueeAnimator.update(context, { text: state.playingFav?.Title ?? '', availableWidth: 97 });
        }
        this.queueRender(context);
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
                    s.fadeOpacity = 1.0;
                    marqueeAnimator.update(context, { text: s.playingFav?.Title ?? '', availableWidth: 97 });
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
            browseTimeoutMs,
            volume: existing?.volume ?? 0,
            isMuted: existing?.isMuted ?? false,
            transportState: existing?.transportState ?? 'STOPPED',
            currentTrack: existing?.currentTrack,
            playingFav: existing?.playingFav,
        });

        marqueeAnimator.start(context, () => { this.queueRender(context); }, {
            text: '',
            fontSize: 14,
            fontColor: '#FFFFFF',
            availableWidth: 97
        });

        this.syncPanoramaParticipation(context, settings);

        await this.renderDial(context);

        if (!settings.deviceIp) return;

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            this.registerReachabilityHandling(controller, ev, 'FAVORITES');
            controller.registerVolumeCallback(context, (vol) => this.onVolumeInfoChanged(context, vol));
            controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
            controller.registerTrackInfoCallback(context, (ti) => this.onTrackInfoChanged(context, ti));

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

            const favs = this.getFavorites();
            const trackTitle = state.currentTrack?.Title ?? '';
            const trackArtist = state.currentTrack?.Artist ?? '';
            const match = favs.find((f: any) => f.Title === trackTitle || f.Title === trackArtist);
            state.playingFav = match ? { Title: match.Title, AlbumArtUri: match.AlbumArtUri } : undefined;

            if (state.currentIndex === -1) {
                marqueeAnimator.update(context, { text: state.playingFav?.Title ?? '', availableWidth: 97 });
            }

            await this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`[FavDial ${context}] Setup error:`, e);
            await this.renderUnreachableDial(context, 'FAVORITES');
            this.scheduleSetupRetry(ev);
        }
    }

    protected cleanupInstance(context: string): void {
        const state = this.states.get(context);
        if (state?.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        if (state?.fadeTimer) clearInterval(state.fadeTimer);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            controller.unregisterReachabilityCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }

        marqueeAnimator.destroy(context);

        this.renderGen.delete(context);
        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    override async onDialRotate(ev: DialRotateEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const favs = this.getFavorites();
        if (!state || favs.length === 0) return;

        if (state.fadeTimer) {
            clearInterval(state.fadeTimer);
            state.fadeTimer = undefined;
            state.fadeOpacity = undefined;
        }

        const n = favs.length;
        if (state.currentIndex === -1) {
            // First rotation: find currently playing favorite or start at 0.
            const title = state.currentTrack?.Title ?? '';
            const matchIdx = favs.findIndex((f: any) => f.Title === title);
            state.currentIndex = matchIdx !== -1 ? matchIdx : 0;
        } else {
            state.currentIndex = ((state.currentIndex + ev.payload.ticks) % n + n) % n;
        }

        const fav = favs[state.currentIndex];
        marqueeAnimator.update(context, { text: fav.Title ?? '', availableWidth: 97 });

        this.startBrowseTimeout(context);
        this.queueRender(context);
    }

    override async onDialDown(ev: DialDownEvent<FavoritesDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        const favs = this.getFavorites();
        if (!state || !controller || state.currentIndex === -1 || favs.length === 0) return;

        const fav = favs[state.currentIndex];
        if (!fav) return;

        // Switch the dial back to now-playing right away — with a fade the actual track change
        // takes seconds, and the display shouldn't sit in browse mode until it finishes.
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state.currentIndex = -1;
        state.browseTimeoutId = undefined;
        state.playingFav = { Title: fav.Title, AlbumArtUri: fav.AlbumArtUri };
        marqueeAnimator.update(context, { text: fav.Title ?? '', availableWidth: 97 });
        this.queueRender(context);

        const fadeMs = (Number(ev.payload.settings.fadeDuration) || 0) * 1000;
        try {
            if (fadeMs > 0) {
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

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, FavoritesDialSettings>): Promise<void> {
        const payload = ev.payload;
        if (typeof payload !== 'object' || payload === null || !('event' in payload)) return;

        switch ((payload as any).event) {
            case 'get-devices': {
                await discoveryPromise;
                const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: piT('-- Choose device --'), value: '' }, ...items]
                });
                break;
            }
            case 'get-fade-options': {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-fade-options',
                    items: [
                        { label: piT('Off'), value: '0' },
                        { label: '2 s', value: '2' },
                        { label: '3 s', value: '3' },
                        { label: '5 s', value: '5' },
                        { label: '8 s', value: '8' },
                    ],
                });
                break;
            }
            case 'get-viz-options': {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-viz-options',
                    items: [
                        { label: piT('Cover mosaic'), value: 'mosaic' },
                        ...[...effectRegistry.values()].map(def => ({ label: piT(def.displayName), value: def.id })),
                    ],
                });
                break;
            }
            case 'get-align-options': {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-align-options',
                    items: [
                        { label: piT('Left'), value: 'left' },
                        { label: piT('Center'), value: 'center' },
                        { label: piT('Right'), value: 'right' },
                    ],
                });
                break;
            }
        }
    }

    // Full-canvas panorama effect background with a heart icon centered per `align` — filled
    // circle while PLAYING, outline otherwise. No cover/title text: this mode is deliberately a
    // minimal ambient view, independent of the fragile favorite-title matching used elsewhere.
    private async renderIconModeDial(action: ReturnType<typeof streamDeck.actions.getActionById>, context: string, settings: FavoritesDialSettings, isPlaying: boolean): Promise<void> {
        if (!action || !action.isDial()) return;

        const align = settings.align ?? 'center';
        const cx = align === 'left' ? 50 : align === 'right' ? 150 : 100;
        const cy = 50;

        const rawPanoramaKey = panoramaContextGroupKey.get(context);
        const panoramaKey = isPanoramaEffectActive(rawPanoramaKey) ? rawPanoramaKey : undefined;
        const particleFrag = panoramaKey ? renderPanoramaEffectSlice(panoramaKey, getPanoramaSliceOffset(context)) : '';

        const heartPath = isPlaying ? mdiHeartCircle : mdiHeartCircleOutline;
        // mdiHeartCircle's own outer ring only spans 20 of its 24 viewBox units (2px inset each
        // side) — a plain 76px box (VolumeDial pie's rOuter*2) renders visually smaller than the
        // pie, which draws its arcs edge-to-edge with no such built-in padding. Scale the box up
        // so the glyph's actual ring diameter matches the pie's 76px.
        const size = Math.round(76 * (24 / 20));
        const scale = size / 24;

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            panoramaKey
                ? `<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs><rect width="200" height="100" fill="#000"/><g clip-path="url(#c)">${particleFrag}</g>`
                : '<rect width="200" height="100" fill="#0a0a0a"/>',
            `<g transform="translate(${cx - size / 2},${cy - size / 2}) scale(${scale.toFixed(3)})"><path fill="#CCCCCC" d="${heartPath}"/></g>`,
            '</svg>',
        ].join('');

        const img = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        await action.setFeedback({ 'full-canvas': img }).catch(() => {});
    }

    protected async renderDial(context: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        if (!action || !action.isDial() || !state) return;

        const isBrowsing = state.currentIndex !== -1;
        const favs = this.getFavorites();
        const isPlaying = state.transportState === 'PLAYING';

        // Icon mode (effect background + centered heart) replaces idle AND now-playing — browsing
        // always shows the actually-selected favorite's real cover, unaffected. Gated on a
        // configured device so an unconfigured tile still falls through to the cog placeholder
        // below instead of animating an effect nobody can act on.
        const settings = this.settingsMap.get(context);
        if (!isBrowsing && settings?.deviceIp && this.isEffectMode(settings.visualizerMode)) {
            await this.renderIconModeDial(action, context, settings, isPlaying);
            return;
        }

        let cover: string | undefined;
        let subtitleText: string;
        let positionText: string;

        if (isBrowsing && favs.length > 0) {
            const fav = favs[state.currentIndex];
            cover = fav?.AlbumArtUri ? sonosFavoritesCache.getCoverArt(fav.AlbumArtUri) : undefined;
            subtitleText = streamDeck.i18n.translate('Press to play');
            positionText = `${state.currentIndex + 1} / ${favs.length}`;
        } else {
            cover = state.playingFav?.AlbumArtUri
                ? sonosFavoritesCache.getCoverArt(state.playingFav.AlbumArtUri)
                : undefined;
            subtitleText = '';
            positionText = isPlaying ? '▶' : '⏸';
        }

        // Full-canvas idle: not browsing and no cover available.
        if (!isBrowsing && !cover) {
            const svg = this.buildIdleSvg();
            const img = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
            await action.setFeedback({ 'full-canvas': img }).catch(() => {});
            return;
        }

        const coverFrag = cover
            ? `<image href="${cover}" x="4" y="6" width="88" height="88" preserveAspectRatio="xMidYMid slice" clip-path="url(#cc)"/>`
            : `<rect x="4" y="6" width="88" height="88" fill="#2a2a2a" rx="6"/>`;

        const titleFrag = marqueeAnimator.isRunning(context)
            ? marqueeAnimator.render(context, 100, 30, 97, 20)
            : (() => {
                const fallback = isBrowsing
                    ? (favs[state.currentIndex]?.Title ?? '')
                    : (state.playingFav?.Title ?? '');
                return `<text x="100" y="30" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="14" clip-path="url(#tc)">${this.escapeXml(fallback)}</text>`;
            })();

        const fadeOverlay = state.fadeOpacity !== undefined
            ? `<rect width="200" height="100" fill="#000" opacity="${state.fadeOpacity.toFixed(3)}"/>`
            : '';

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            '  <clipPath id="cc"><rect x="4" y="6" width="88" height="88" rx="6"/></clipPath>',
            '  <clipPath id="tc"><rect x="100" y="5" width="97" height="58"/></clipPath>',
            '</defs>',
            '<rect width="200" height="100" fill="#1c1c1c"/>',
            coverFrag,
            titleFrag,
            `<text x="100" y="48" fill="#999999" font-family="Arial,sans-serif" font-size="11" clip-path="url(#tc)">${this.escapeXml(subtitleText)}</text>`,
            `<text x="197" y="62" fill="#999999" font-family="Arial,sans-serif" font-size="10" text-anchor="end">${this.escapeXml(positionText)}</text>`,
            isBrowsing ? this.renderDots(state.currentIndex, favs.length) : '',
            isBrowsing ? '<rect x="0.5" y="0.5" width="199" height="99" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity="0.15" rx="2"/>' : '',
            fadeOverlay,
            '</svg>'
        ].join('');

        const img = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        await action.setFeedback({ 'full-canvas': img }).catch(() => {});
    }

    private getAvailableCovers(max: number): string[] {
        const favs = this.getFavorites();
        const covers: string[] = [];
        for (const fav of favs) {
            if (covers.length >= max) break;
            const art = fav.AlbumArtUri ? sonosFavoritesCache.getCoverArt(fav.AlbumArtUri) : undefined;
            if (art) covers.push(art);
        }
        return covers;
    }

    private buildIdleSvg(): string {
        const covers = this.getAvailableCovers(8);

        const body = covers.length === 0
            ? [
                `<g transform="translate(82,14) scale(1.5)"><path fill="${INACTIVE_ICON_COLOR}" d="${mdiCog}"/></g>`,
                `<text x="100" y="66" fill="#555555" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">${this.escapeXml(streamDeck.i18n.translate('No device set'))}</text>`,
            ].join('')
            : this.buildMosaic(covers);

        const hint = covers.length > 0
            ? `<text x="100" y="96" fill="#fff" font-family="Arial,sans-serif" font-size="9" text-anchor="middle" opacity="0.4">${this.escapeXml(streamDeck.i18n.translate('Rotate to browse'))}</text>`
            : '';

        return [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs><clipPath id="vp"><rect width="200" height="100"/></clipPath></defs>',
            '<rect width="200" height="100" fill="#111"/>',
            `<g clip-path="url(#vp)">${body}</g>`,
            hint,
            '</svg>',
        ].join('');
    }

    private buildMosaic(covers: string[]): string {
        const COLS = 4, ROWS = 2, W = 50, H = 50;
        const total = COLS * ROWS;
        const defs: string[] = [];
        const imgs: string[] = [];
        for (let i = 0; i < total; i++) {
            const col = i % COLS, row = Math.floor(i / COLS);
            const x = col * W, y = row * H;
            defs.push(`<clipPath id="ms${i}"><rect x="${x}" y="${y}" width="${W}" height="${H}"/></clipPath>`);
            imgs.push(`<image href="${covers[i % covers.length]}" x="${x}" y="${y}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" clip-path="url(#ms${i})"/>`);
        }
        return `<defs>${defs.join('')}</defs>${imgs.join('')}`;
    }


    private renderDots(current: number, total: number): string {
        if (total <= 1) return '';

        if (total > 15) {
            const fillW = Math.round(180 * current / (total - 1));
            return [
                `<rect x="10" y="86" width="180" height="4" fill="#333" rx="2"/>`,
                fillW > 0 ? `<rect x="10" y="86" width="${fillW}" height="4" fill="#CCCCCC" rx="2"/>` : '',
            ].join('');
        }

        const dotR = total <= 10 ? 2.5 : 2;
        const activeR = total <= 10 ? 3.5 : 3;
        const gap = Math.round(180 / Math.max(1, total - 1));
        const startX = Math.round((200 - (total - 1) * gap) / 2);

        return Array.from({ length: total }, (_, i) => {
            const cx = startX + i * gap;
            return `<circle cx="${cx}" cy="88" r="${i === current ? activeR : dotR}" fill="${i === current ? '#FFFFFF' : '#484848'}"/>`;
        }).join('');
    }

    private escapeXml(s: string): string {
        return String(s).replace(/[<>&"']/g, (c) =>
            ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' } as any)[c] || c
        );
    }
}
