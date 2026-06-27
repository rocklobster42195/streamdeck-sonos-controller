import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    SingletonAction,
    DialDownEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
    TouchTapEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise, sonosFavoritesCache } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { TrackInfo, VolumeInfo } from "../sonos/SonosTypes";
import { marqueeAnimator } from "../utils/MarqueeAnimator";

type SonosFavDialSettings = {
    deviceIp?: string;
    browseTimeout?: number; // seconds before returning to now-playing, default 3
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
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-favorites" })
export class SonosDialFavorites extends SingletonAction<SonosFavDialSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, FavDialState> = new Map();
    private renderGen: Map<string, number> = new Map();

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
            s.currentIndex = -1;
            s.browseTimeoutId = undefined;
            marqueeAnimator.update(context, { text: s.playingFav?.Title ?? '', availableWidth: 97 });
            this.queueRender(context);
        }, state.browseTimeoutMs);
    }

    private async onInstanceUpdate(ev: WillAppearEvent<SonosFavDialSettings> | DidReceiveSettingsEvent<SonosFavDialSettings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;

        const old = this.controllers.get(context);
        if (old) {
            old.unregisterVolumeCallback(context);
            old.unregisterTransportStateCallback(context);
            old.unregisterTrackInfoCallback(context);
            sonosDeviceManager.releaseController(old.deviceIp);
            this.controllers.delete(context);
        }

        const existing = this.states.get(context);
        const browseTimeoutMs = (settings.browseTimeout ?? 3) * 1000;

        // Preserve browse position when only settings change.
        this.states.set(context, {
            currentIndex: existing?.currentIndex ?? -1,
            browseTimeoutMs,
            volume: existing?.volume ?? 0,
            isMuted: existing?.isMuted ?? false,
            transportState: existing?.transportState ?? 'STOPPED',
            currentTrack: existing?.currentTrack,
        });

        marqueeAnimator.start(context, () => { this.queueRender(context); }, {
            text: '',
            fontSize: 14,
            fontColor: '#FFFFFF',
            availableWidth: 97
        });

        await this.renderDial(context);

        if (!settings.deviceIp) return;

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

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
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosFavDialSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosFavDialSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosFavDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (state?.browseTimeoutId) clearTimeout(state.browseTimeoutId);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }

        this.controllers.delete(context);
        this.states.delete(context);
        this.renderGen.delete(context);
        marqueeAnimator.destroy(context);
    }

    override async onDialRotate(ev: DialRotateEvent<SonosFavDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const favs = this.getFavorites();
        if (!state || favs.length === 0) return;

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

    override async onDialDown(ev: DialDownEvent<SonosFavDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        const favs = this.getFavorites();
        if (!state || !controller || state.currentIndex === -1 || favs.length === 0) return;

        const fav = favs[state.currentIndex];
        if (!fav) return;

        try {
            await controller.playFavorite(fav);
            if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
            state.currentIndex = -1;
            state.browseTimeoutId = undefined;
            // Show the selected favorite immediately without waiting for the track-info event.
            state.playingFav = { Title: fav.Title, AlbumArtUri: fav.AlbumArtUri };
            marqueeAnimator.update(context, { text: fav.Title ?? '', availableWidth: 97 });
            this.queueRender(context);
        } catch (e) {
            streamDeck.logger.error(`[FavDial] Error playing favorite "${fav.Title}":`, e);
        }
    }

    override async onTouchTap(ev: TouchTapEvent<SonosFavDialSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        if (state.browseTimeoutId) clearTimeout(state.browseTimeoutId);
        state.currentIndex = -1;
        state.browseTimeoutId = undefined;
        marqueeAnimator.update(context, { text: state.playingFav?.Title ?? '', availableWidth: 97 });
        this.queueRender(context);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosFavDialSettings>): Promise<void> {
        const payload = ev.payload;
        if (typeof payload !== 'object' || payload === null || !('event' in payload)) return;

        switch ((payload as any).event) {
            case 'get-devices': {
                await discoveryPromise;
                const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- Choose device --', value: '' }, ...items]
                });
                break;
            }
        }
    }

    private async renderDial(context: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        if (!action || !action.isDial() || !state) return;

        const isBrowsing = state.currentIndex !== -1;
        const favs = this.getFavorites();
        const isPlaying = state.transportState === 'PLAYING';

        let cover: string | undefined;
        let subtitleText: string;
        let positionText: string;

        if (isBrowsing && favs.length > 0) {
            const fav = favs[state.currentIndex];
            cover = fav?.AlbumArtUri ? sonosFavoritesCache.getCoverArt(fav.AlbumArtUri) : undefined;
            subtitleText = 'Press to play';
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
            await action.setFeedback({
                'full-canvas': img, 'icon': '', 'title': '',
                'indicator': { value: 0, enabled: false },
            }).catch(() => {});
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

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs>',
            '  <clipPath id="cc"><rect x="4" y="6" width="88" height="88" rx="6"/></clipPath>',
            '  <clipPath id="tc"><rect x="100" y="5" width="97" height="58"/></clipPath>',
            '</defs>',
            '<rect width="200" height="100" fill="#1c1c1c"/>',
            coverFrag,
            titleFrag,
            `<text x="100" y="48" fill="#888" font-family="Arial,sans-serif" font-size="11" clip-path="url(#tc)">${this.escapeXml(subtitleText)}</text>`,
            `<text x="197" y="62" fill="#666" font-family="Arial,sans-serif" font-size="10" text-anchor="end">${this.escapeXml(positionText)}</text>`,
            isBrowsing ? this.renderDots(state.currentIndex, favs.length) : '',
            isBrowsing ? '<rect x="0.5" y="0.5" width="199" height="99" fill="none" stroke="#ffffff" stroke-width="1" stroke-opacity="0.15" rx="2"/>' : '',
            '</svg>'
        ].join('');

        const img = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
        await action.setFeedback({
            'full-canvas': img,
            'icon': '',
            'title': '',
            'indicator': { value: 0, enabled: false }
        }).catch(() => {});
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
            ? '<text x="100" y="55" fill="#444" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">No device set</text>'
            : this.buildMosaic(covers);

        const hint = covers.length > 0
            ? '<text x="100" y="96" fill="#fff" font-family="Arial,sans-serif" font-size="9" text-anchor="middle" opacity="0.4">Rotate to browse</text>'
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
