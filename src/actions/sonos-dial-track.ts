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
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { CoverArtAnimator } from "../utils/CoverArtAnimator";
import { titleAnimator } from "../utils/TitleAnimator";
import { marqueeAnimator } from "../utils/MarqueeAnimator";
import { getDominantColor } from "../utils/colorExtract";
import { particleEngine } from "../utils/ParticleEngine";
import { panoramaContextGroupKey, registerInPanorama, unregisterFromPanorama, getPanoramaSliceOffset } from "./sonos-dial-particles";
import { TrackInfo } from "../sonos/SonosTypes";

type SonosSettings = {
    deviceIp?: string;
    showTrackTitle?: boolean;
    fontColor?: string;
    fontSize?: number;
    marqueeSpeed?: number;
    marqueePause?: number;
    visualizerMode?: 'eq' | 'particles' | 'none';
    particleCount?: number;
    particleSpeed?: number;
};

interface DialState {
    trackInfo?: TrackInfo;
    transportState: string;
    dominantColor: string;
    lastColorUri?: string;
    trackDuration: number;
    trackPosition: number;
    trackPositionTime: number;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-track" })
export class SonosDialTrack extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, DialState> = new Map();
    private animators: Map<string, CoverArtAnimator> = new Map();
    private settingsMap: Map<string, SonosSettings> = new Map();
    private marqueeTimers: Map<string, NodeJS.Timeout> = new Map();
    private animTimers: Map<string, NodeJS.Timeout> = new Map();
    private contextColumns: Map<string, number> = new Map();

    private onTransportStateChanged(context: string, transportState: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.transportState = transportState;
        const settings = this.settingsMap.get(context);
        const inPanorama = settings?.visualizerMode === 'particles' && !!panoramaContextGroupKey.get(context);
        if (transportState === 'PLAYING' || inPanorama) {
            this.startAnimTimer(context);
            if (transportState === 'PLAYING') {
                const controller = this.controllers.get(context);
                if (controller) void this.fetchAndStorePosition(context, controller);
            }
        } else {
            this.stopAnimTimer(context);
        }
        void this.renderDial(context);
    }

    private async onTrackInfoChanged(context: string, trackInfo: TrackInfo): Promise<void> {
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (!state || !animator) return;

        // Preserve visible cover when the new event carries no art (e.g. radio news segment).
        if (!trackInfo.albumArtDataUri && state.trackInfo?.albumArtDataUri) {
            trackInfo = { ...trackInfo, albumArtDataUri: state.trackInfo.albumArtDataUri };
        }
        state.trackInfo = trackInfo;
        animator.updateImage(context, trackInfo.albumArtDataUri);

        // Extract dominant color only when the cover changes.
        const newCover = trackInfo.albumArtDataUri;
        if (newCover && newCover !== state.lastColorUri) {
            state.lastColorUri = newCover;
            getDominantColor(newCover).then(color => {
                const s = this.states.get(context);
                if (!s) return;
                s.dominantColor = color;
                particleEngine.setColor(context, this.ensureVisibleColor(color));
                void this.renderDial(context);
            }).catch(() => {});
        }

        const controller = this.controllers.get(context);
        if (controller) void this.fetchAndStorePosition(context, controller);

        const settings = this.settingsMap.get(context);
        const marqWidth = this.marqWidth(settings);
        const text = trackInfo.Title ?? '';
        await this.updateTitleMarquee(context, text, settings?.fontSize ?? 14, marqWidth, settings);
        void this.renderDial(context);
    }

    // Drives re-renders for progress bar and animations.
    // In panorama particles mode the timer stays alive regardless of play state;
    // the panorama group timer handles physics ticking.
    private startAnimTimer(context: string): void {
        if (this.animTimers.has(context)) return;
        const timer = setInterval(() => {
            const s = this.states.get(context);
            if (!s) { this.stopAnimTimer(context); return; }
            const settings = this.settingsMap.get(context);
            const inPanorama = settings?.visualizerMode === 'particles' && !!panoramaContextGroupKey.get(context);
            if (!inPanorama && s.transportState !== 'PLAYING') {
                this.stopAnimTimer(context);
                return;
            }
            // Tick standalone particles only when not in a panorama group.
            if (settings?.visualizerMode === 'particles' && !inPanorama) particleEngine.tick(context);
            void this.renderDial(context);
        }, 100);
        this.animTimers.set(context, timer);
    }

    private stopAnimTimer(context: string): void {
        const timer = this.animTimers.get(context);
        if (timer) { clearInterval(timer); this.animTimers.delete(context); }
    }

    private marqWidth(_settings?: SonosSettings): number {
        return 97;
    }

    private estimateTextWidth(text: string, fontSize: number): number {
        return Math.max(0, Math.ceil(text.length * fontSize * 0.55) + 4);
    }

    private async computeTruncatedText(text: string, fontSize: number, availableWidth: number): Promise<string> {
        try {
            const fullWidth = await titleAnimator.measure(text, fontSize);
            if (fullWidth <= availableWidth) return text;
        } catch { /* fall through to binary search */ }

        let lo = 0, hi = text.length, best = '';
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = text.substring(0, mid) + '…';
            let w: number;
            try { w = await titleAnimator.measure(candidate, fontSize); }
            catch { w = this.estimateTextWidth(candidate, fontSize); }
            if (w <= availableWidth) { best = candidate; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return best || text.substring(0, Math.max(0, Math.floor(availableWidth / (fontSize * 0.55)) - 1)) + '…';
    }

    private async updateTitleMarquee(context: string, fullText: string, fontSize: number, availableWidth: number, settings?: SonosSettings) {
        const prev = this.marqueeTimers.get(context);
        if (prev) { clearTimeout(prev); this.marqueeTimers.delete(context); }

        const fontColor = settings?.fontColor ?? '#FFFFFF';
        const speed = settings?.marqueeSpeed;
        const pauseDuration = settings?.marqueePause;

        let measuredFull: number | undefined;
        try { measuredFull = await titleAnimator.measure(fullText, fontSize); } catch { /* use estimate */ }

        if ((measuredFull ?? this.estimateTextWidth(fullText, fontSize)) <= availableWidth) {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredFull, availableWidth });
            return;
        }

        const preview = await this.computeTruncatedText(fullText, fontSize, availableWidth);
        let measuredPreview: number | undefined;
        try { measuredPreview = await titleAnimator.measure(preview, fontSize); }
        catch { measuredPreview = this.estimateTextWidth(preview, fontSize); }

        marqueeAnimator.update(context, { text: preview, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredPreview, availableWidth });

        const t = setTimeout(() => {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredFull, availableWidth });
            this.marqueeTimers.delete(context);
        }, 1500);
        this.marqueeTimers.set(context, t);
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;
        const { deviceIp } = settings;

        this.cleanupInstance(context);
        this.settingsMap.set(context, settings);

        const animator = new CoverArtAnimator();
        this.animators.set(context, animator);
        animator.start(context, () => { void this.renderDial(context); });

        marqueeAnimator.start(context, () => { void this.renderDial(context); }, {
            text: '',
            fontSize: settings.fontSize ?? 14,
            fontColor: settings.fontColor ?? '#FFFFFF',
            speed: settings.marqueeSpeed,
            pauseDuration: settings.marqueePause,
            availableWidth: this.marqWidth(settings),
        });

        this.states.set(context, {
            transportState: 'STOPPED',
            dominantColor: '#CCCCCC',
            trackDuration: 0,
            trackPosition: 0,
            trackPositionTime: Date.now(),
        });

        if (settings.visualizerMode === 'particles') {
            // Standalone engine as fallback when no adjacent Panorama Particles dials form a group.
            particleEngine.init(context, {
                width: 100, height: 38,
                color: '#CCCCCC',
                mode: 'network',
                connectDistance: 40,
                minRadius: 1.5,
                maxRadius: 3,
                opacity: 0.85,
                count: settings.particleCount ?? 12,
                maxSpeed: settings.particleSpeed != null ? settings.particleSpeed / 10 : 0.4,
            });
            // Register in shared panorama column map so adjacent Panorama Particles dials
            // can include this display in their group (auto-adjacency detection).
            const col = this.contextColumns.get(context) ?? 0;
            registerInPanorama(context, col);
        } else {
            unregisterFromPanorama(context);
        }

        await this.renderDial(context);

        if (!deviceIp) return;

        try {
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
            controller.registerTrackInfoCallback(context, (ti) => { void this.onTrackInfoChanged(context, ti); });

            const [transportState, track] = await Promise.all([
                controller.getTransportState(),
                controller.getCurrentTrack(),
            ]);

            const state = this.states.get(context)!;
            state.transportState = transportState;
            if (transportState === 'PLAYING' || settings.visualizerMode === 'particles') this.startAnimTimer(context);
            if (track) state.trackInfo = track;

            await this.fetchAndStorePosition(context, controller);

            // For radio, getCurrentTrack() returns undefined; derive cover from stream URI.
            const cover = await controller.getCurrentTrackCover();
            if (cover) {
                if (!state.trackInfo) state.trackInfo = {} as TrackInfo;
                state.trackInfo.albumArtDataUri = cover;
                animator.updateImage(context, cover);

                state.lastColorUri = cover;
                getDominantColor(cover).then(c => {
                    const s = this.states.get(context);
                    if (!s) return;
                    s.dominantColor = c;
                    particleEngine.setColor(context, this.ensureVisibleColor(c));
                    void this.renderDial(context);
                }).catch(() => {});

                const text = state.trackInfo.Title ?? '';
                await this.updateTitleMarquee(context, text, settings.fontSize ?? 14, this.marqWidth(settings), settings);
            }

            await this.renderDial(context);

        } catch (e) {
            streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        const col = 'coordinates' in ev.payload
            ? (ev.payload.coordinates as { column: number }).column : 0;
        this.contextColumns.set(ev.action.id, col);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosSettings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
        this.contextColumns.delete(ev.action.id);
    }

    private cleanupInstance(context: string): void {
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }

        this.stopAnimTimer(context);
        unregisterFromPanorama(context);
        particleEngine.destroy(context);

        const animator = this.animators.get(context);
        if (animator) { animator.destroy(context); this.animators.delete(context); }

        marqueeAnimator.destroy(context);

        const mt = this.marqueeTimers.get(context);
        if (mt) { clearTimeout(mt); this.marqueeTimers.delete(context); }

        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    // Dial press → next track so the user can browse playlists.
    override async onDialDown(ev: DialDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) await controller.next();
    }

    // Touch tap → toggle play / pause.
    override async onTouchTap(ev: TouchTapEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) await controller.togglePlayPause();
    }

    // Dial rotation → seek ±5 % per tick in the current track.
    override async onDialRotate(ev: DialRotateEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state || state.trackDuration <= 5) return;

        const elapsed = state.transportState === 'PLAYING'
            ? (Date.now() - state.trackPositionTime) / 1000 : 0;
        const current = state.trackPosition + elapsed;
        const newPos = Math.max(0, Math.min(state.trackDuration, current + ev.payload.ticks * state.trackDuration * 0.05));

        // Update immediately so the progress bar responds without waiting for the seek to confirm.
        state.trackPosition = newPos;
        state.trackPositionTime = Date.now();
        void this.renderDial(context);

        try {
            await controller.sonosDevice.AVTransportService.Seek({
                InstanceID: 0,
                Unit: 'REL_TIME',
                Target: this.formatRelTime(newPos),
            });
        } catch (e) {
            streamDeck.logger.warn('Seek failed', e);
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;
                const deviceItems = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- Choose Device --', value: '' }, ...deviceItems]
                });
            }
            if (ev.payload.event === 'get-particle-state') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'particle-state',
                    inPanorama: !!panoramaContextGroupKey.get(ev.action.id),
                });
            }
        }
    }

    private parseRelTime(t: string): number {
        if (!t || t === 'NOT_IMPLEMENTED') return 0;
        const parts = t.split(':').map(Number);
        return (parts.length === 3 && parts.every(n => !isNaN(n)))
            ? parts[0] * 3600 + parts[1] * 60 + parts[2]
            : 0;
    }

    private formatRelTime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    private async fetchAndStorePosition(context: string, controller: SonosDeviceController): Promise<void> {
        try {
            const pos = await controller.sonosDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
            const state = this.states.get(context);
            if (!state) return;
            state.trackPosition = this.parseRelTime(pos.RelTime);
            state.trackDuration = this.parseRelTime(pos.TrackDuration);
            state.trackPositionTime = Date.now();
        } catch { /* position stays at last known value */ }
    }

    private ensureVisibleColor(color: string): string {
        const m = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
        if (!m) return '#CCCCCC';
        const [r, g, b] = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= 0.25) return color;
        const mix = (v: number) => Math.min(255, Math.round(v * 255 + 255 * 0.55));
        return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
    }

    private renderEqualizerBars(color: string, amplitude = 1): string {
        const base = [8, 14, 10, 18, 6, 12, 16, 8, 14, 10];
        return base.map((h, i) => {
            const full = Math.max(4, Math.min(18, h + Math.floor(Math.random() * 10 - 5)));
            const rh = Math.max(1, Math.round(full * amplitude));
            const op = (0.75 * amplitude).toFixed(2);
            return `<rect x="${8 + i * 9}" y="${90 - rh}" width="7" height="${rh}" fill="${this.escapeXml(color)}" opacity="${op}" rx="1"/>`;
        }).join('');
    }

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (!sdAction || !sdAction.isDial() || !state || !animator) return;

        const settings = this.settingsMap.get(context);

        // No device configured: show a minimal ready screen.
        if (!settings?.deviceIp) {
            const readySvg = [
                '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                '<rect width="200" height="100" fill="#0a0a0a"/>',
                '<text x="100" y="48" fill="#2a2a2a" font-family="Arial,sans-serif" font-size="34" text-anchor="middle">♪</text>',
                '<text x="100" y="68" fill="#333" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" letter-spacing="2">SONOS</text>',
                '</svg>',
            ].join('');
            const img = `data:image/svg+xml;base64,${Buffer.from(readySvg).toString('base64')}`;
            await sdAction.setFeedback({ 'full-canvas': img, 'title': '' }).catch(() => {});
            return;
        }

        const isPlaying = state.transportState === 'PLAYING';
        const isTransitioning = state.transportState === 'TRANSITIONING';
        const artist = state.trackInfo?.Artist ?? '';
        const accentColor = this.ensureVisibleColor(state.dominantColor);
        const textOpacity = (isPlaying || isTransitioning) ? 1 : 0.6;
        const fontSize = settings?.fontSize ?? 14;
        const fontColor = settings?.fontColor ?? '#FFFFFF';
        const visualizerMode = settings?.visualizerMode ?? 'eq';

        const elapsed = isPlaying ? (Date.now() - state.trackPositionTime) / 1000 : 0;
        const currentPos = state.trackPosition + elapsed;
        const progress = state.trackDuration > 5 ? Math.min(1, currentPos / state.trackDuration) : 0;
        const progressPct = Math.round(progress * 100);

        // EQ fade-out: shrink bars linearly over the last 3 seconds of a track.
        const FADE_SECS = 3;
        const timeRemaining = state.trackDuration > 5 ? state.trackDuration - currentPos : Infinity;
        const eqAmplitude = (isPlaying && timeRemaining < FADE_SECS)
            ? Math.max(0, timeRemaining / FADE_SECS)
            : 1;

        let svg: string;

        if (visualizerMode === 'none') {
            const sharpCover = animator.render(context, 113, 4, 87, 92);

            let titleFrag = '';
            if (settings?.showTrackTitle !== false) {
                if (marqueeAnimator.isRunning(context)) {
                    titleFrag = marqueeAnimator.render(context, 8, 68, 97, 20);
                } else {
                    const t = this.escapeXml(state.trackInfo?.Title ?? 'Sonos');
                    titleFrag = `<text x="8" y="68" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                }
            }

            svg = [
                '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                '<defs>',
                '  <clipPath id="textClip"><rect x="8" y="2" width="97" height="96"/></clipPath>',
                '  <clipPath id="coverClip"><rect x="113" y="4" width="87" height="92" rx="6"/></clipPath>',
                '</defs>',
                '<rect width="200" height="100" fill="black"/>',
                `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                titleFrag,
                `  <text x="8" y="82" fill="#999999" font-family="Arial,sans-serif" font-size="11">${this.escapeXml(artist)}</text>`,
                '</g>',
                `<rect x="8" y="91" width="97" height="3" fill="white" opacity="0.12" rx="1.5"/>`,
                progressPct > 0 ? `<rect x="8" y="91" width="${Math.round(97 * progress)}" height="3" fill="${this.escapeXml(accentColor)}" opacity="0.9" rx="1.5"/>` : '',
                `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                '</svg>',
            ].join('');
        } else {
            const sharpCover = animator.render(context, 113, 4, 87, 92);

            let titleFrag = '';
            if (settings?.showTrackTitle !== false) {
                if (marqueeAnimator.isRunning(context)) {
                    titleFrag = marqueeAnimator.render(context, 8, 22, 97, 20);
                } else {
                    const t = this.escapeXml(state.trackInfo?.Title ?? 'Sonos');
                    titleFrag = `<text x="8" y="22" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                }
            }

            const panoramaKey = visualizerMode === 'particles' ? panoramaContextGroupKey.get(context) : undefined;

            if (panoramaKey) {
                // Panorama mode: particles as full-canvas background; text layout same as 'none' (bottom-aligned).
                const sliceOffset = getPanoramaSliceOffset(context);
                const particleFrag = particleEngine.renderPanoramaSlice(panoramaKey, sliceOffset);

                let panoTitleFrag = '';
                if (settings?.showTrackTitle !== false) {
                    if (marqueeAnimator.isRunning(context)) {
                        panoTitleFrag = marqueeAnimator.render(context, 8, 68, 97, 20);
                    } else {
                        const t = this.escapeXml(state.trackInfo?.Title ?? 'Sonos');
                        panoTitleFrag = `<text x="8" y="68" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                    }
                }

                svg = [
                    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                    '<defs>',
                    '  <clipPath id="c"><rect width="200" height="100"/></clipPath>',
                    '  <linearGradient id="overlay" x1="0" x2="0" y1="0" y2="1">',
                    '    <stop offset="40%" stop-color="black" stop-opacity="0"/>',
                    '    <stop offset="100%" stop-color="black" stop-opacity="0.75"/>',
                    '  </linearGradient>',
                    '  <clipPath id="textClip"><rect x="8" y="2" width="97" height="96"/></clipPath>',
                    '  <clipPath id="coverClip"><rect x="113" y="4" width="87" height="92" rx="6"/></clipPath>',
                    '</defs>',
                    '<rect width="200" height="100" fill="#000"/>',
                    `<g clip-path="url(#c)">${particleFrag}</g>`,
                    '<rect width="200" height="100" fill="url(#overlay)"/>',
                    `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                    panoTitleFrag,
                    `  <text x="8" y="82" fill="#999999" font-family="Arial,sans-serif" font-size="11">${this.escapeXml(artist)}</text>`,
                    '</g>',
                    `<rect x="8" y="91" width="97" height="3" fill="white" opacity="0.12" rx="1.5"/>`,
                    progressPct > 0 ? `<rect x="8" y="91" width="${Math.round(97 * progress)}" height="3" fill="${this.escapeXml(accentColor)}" opacity="0.9" rx="1.5"/>` : '',
                    `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                    '</svg>',
                ].join('');
            } else {
                // Eq / standalone-particles layout: dark background, visualizer bottom-left.
                const isParticles = visualizerMode === 'particles';
                const visualizer = isPlaying
                    ? (isParticles
                        ? `<g clip-path="url(#particleClip)">${particleEngine.render(context, 8, 56)}</g>`
                        : this.renderEqualizerBars(accentColor, eqAmplitude))
                    : '';

                svg = [
                    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                    '<defs>',
                    '  <clipPath id="textClip"><rect x="8" y="2" width="97" height="96"/></clipPath>',
                    '  <clipPath id="coverClip"><rect x="113" y="4" width="87" height="92" rx="6"/></clipPath>',
                    '  <clipPath id="particleClip"><rect x="8" y="56" width="100" height="38"/></clipPath>',
                    '</defs>',
                    '<rect width="200" height="100" fill="black"/>',
                    `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                    titleFrag,
                    `  <text x="8" y="38" fill="#999999" font-family="Arial,sans-serif" font-size="12">${this.escapeXml(artist)}</text>`,
                    '</g>',
                    `<rect x="8" y="49" width="100" height="3" fill="white" opacity="0.12" rx="1.5"/>`,
                    progressPct > 0 ? `<rect x="8" y="49" width="${progressPct}" height="3" fill="${this.escapeXml(accentColor)}" opacity="0.9" rx="1.5"/>` : '',
                    visualizer,
                    `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                    '</svg>',
                ].join('');
            }
        }

        const finalImage = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

        await sdAction.setFeedback({
            'full-canvas': finalImage,
            'icon': '',
            'title': '',
            'indicator': { 'value': progressPct },
        }).catch(() => {});
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
