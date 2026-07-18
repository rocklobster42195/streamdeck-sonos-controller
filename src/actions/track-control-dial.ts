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
import { CoverArtAnimator } from "../utils/CoverArtAnimator";
import { titleAnimator } from "../utils/TitleAnimator";
import { marqueeAnimator } from "../utils/MarqueeAnimator";
import { getDominantColor, ensureVisibleColor } from "../utils/color-extract";
import { escapeXml } from "../utils/xml";
import { measureArialWidth } from "../utils/text-width";
import { parseRelTime, formatRelTime } from "../sonos/rel-time";
import { panoramaContextGroupKey, getPanoramaSliceOffset, groupEffects, renderPanoramaEffectSlice, isPanoramaEffectActive } from "../effects/PanoramaOrchestrator";
import { TrackInfo } from "../sonos/SonosTypes";
import { SonosBatteryStatus, deviceHasBattery } from "../sonos/SonosBattery";
import { syncCapabilityFlag } from "./capability-flag";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendVizOptions, sendBatteryModeOptions } from "./pi-options";
import { buildUnconfiguredDialSvg, renderBatteryBadge } from "../utils/icons";

type TrackControlDialSettings = PanoramaCapableSettings & {
    deviceIp?: string;
    showTrackTitle?: boolean;
    fontColor?: string;
    fontSize?: number;
    marqueeSpeed?: number;
    marqueePause?: number;
    // 'off' | 'warning' (icon only while battery is low) | 'full' (always shows level/charging).
    // Only ever rendered when the device actually reports battery data (Roam/Move) — see
    // SonosBattery.ts. Defaults to 'warning' via applyBackfill's extraDefaults.
    batteryDisplayMode?: 'off' | 'warning' | 'full';
    // Internal, PI-only field: whether the current deviceIp reports battery data — refreshed on
    // every settings sync (see onInstanceUpdate) and written back via setSettings() so the PI can
    // react to it through the settings-sync channel (a hidden <sdpi-checkbox setting="hasBattery">
    // toggles the battery-mode dropdown's visibility — see battery-capability.js).
    hasBattery?: boolean;
    // visualizerMode ('none' | 'eq' | any registered effect id) and effect-specific tunable
    // fields (e.g. savedDensity/savedSpeed/primaryColor, written by the generic PI field
    // renderer ui/effect-fields.js) come from PanoramaCapableSettings.
};

interface DialState {
    trackInfo?: TrackInfo;
    transportState: string;
    dominantColor: string;
    lastColorUri?: string;
    trackDuration: number;
    trackPosition: number;
    trackPositionTime: number;
    batteryStatus?: SonosBatteryStatus;
}

@action({ UUID: "de.boriskemper.sonos-controller.track-control-dial" })
export class TrackControlDial extends PanoramaCapableDialAction<TrackControlDialSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, DialState> = new Map();
    private animators: Map<string, CoverArtAnimator> = new Map();
    private marqueeTimers: Map<string, NodeJS.Timeout> = new Map();

    // Track Dial also excludes 'eq' (its own non-effect equalizer mode) besides 'none'.
    protected override isEffectMode(mode?: string): boolean {
        return !!mode && mode !== 'none' && mode !== 'eq';
    }

    // Keeps the shared anim timer alive while actively playing too (drives the progress bar /
    // cover animation), not just while an effect is running.
    protected override shouldKeepAnimating(context: string): boolean {
        return this.states.get(context)?.transportState === 'PLAYING';
    }

    private onTransportStateChanged(context: string, transportState: string): void {
        const state = this.states.get(context);
        if (!state) return;
        state.transportState = transportState;
        const settings = this.settingsMap.get(context);
        const panoKey0 = this.isEffectMode(settings?.visualizerMode) ? panoramaContextGroupKey.get(context) : undefined;
        const inPanorama = isPanoramaEffectActive(panoKey0);
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
                const visibleColor = ensureVisibleColor(color);
                const pk = panoramaContextGroupKey.get(context);
                if (isPanoramaEffectActive(pk)) {
                    groupEffects.get(pk!)?.onSettingsChange?.({ color: visibleColor });
                }
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

    private onBatteryChanged(context: string, battery: SonosBatteryStatus | undefined): void {
        const state = this.states.get(context);
        if (!state) return;
        state.batteryStatus = battery;
        void this.renderDial(context);
    }

    private marqWidth(_settings?: TrackControlDialSettings): number {
        return 97;
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
            catch { w = measureArialWidth(candidate, fontSize); }
            if (w <= availableWidth) { best = candidate; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return best || text.substring(0, Math.max(0, Math.floor(availableWidth / (fontSize * 0.55)) - 1)) + '…';
    }

    private async updateTitleMarquee(context: string, fullText: string, fontSize: number, availableWidth: number, settings?: TrackControlDialSettings) {
        const prev = this.marqueeTimers.get(context);
        if (prev) { clearTimeout(prev); this.marqueeTimers.delete(context); }

        const fontColor = settings?.fontColor ?? '#FFFFFF';
        const speed = settings?.marqueeSpeed;
        const pauseDuration = settings?.marqueePause;

        let measuredFull: number | undefined;
        try { measuredFull = await titleAnimator.measure(fullText, fontSize); } catch { /* use estimate */ }

        if ((measuredFull ?? measureArialWidth(fullText, fontSize)) <= availableWidth) {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredFull, availableWidth });
            return;
        }

        const preview = await this.computeTruncatedText(fullText, fontSize, availableWidth);
        let measuredPreview: number | undefined;
        try { measuredPreview = await titleAnimator.measure(preview, fontSize); }
        catch { measuredPreview = measureArialWidth(preview, fontSize); }

        marqueeAnimator.update(context, { text: preview, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredPreview, availableWidth });

        const t = setTimeout(() => {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor, speed, pauseDuration, measuredWidth: measuredFull, availableWidth });
            this.marqueeTimers.delete(context);
        }, 1500);
        this.marqueeTimers.set(context, t);
    }

    protected override async onInstanceUpdate(ev: WillAppearEvent<TrackControlDialSettings> | DidReceiveSettingsEvent<TrackControlDialSettings>): Promise<void> {
        const context = ev.action.id;
        let settings = ev.payload.settings;

        this.cleanupInstance(context);

        settings = this.applyBackfill(ev, settings, { batteryDisplayMode: 'warning' });

        const { deviceIp } = settings;
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

        this.syncPanoramaParticipation(context, settings);

        await this.renderDial(context);

        if (!deviceIp) return;

        try {
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            // undefined means "couldn't determine right now" — leave the persisted hasBattery
            // flag as it was rather than writing a false negative (see deviceHasBattery's own
            // doc comment for the hardware case this fixes).
            const hasBatteryResult = await deviceHasBattery(deviceIp);
            if (hasBatteryResult !== undefined) {
                settings = await syncCapabilityFlag(ev.action, settings, 'hasBattery', hasBatteryResult);
            }
            this.settingsMap.set(context, settings);

            if (!this.registerReachabilityHandling(controller, ev, 'TRACK')) return;
            controller.registerTransportStateCallback(context, (ts) => this.onTransportStateChanged(context, ts));
            controller.registerTrackInfoCallback(context, (ti) => { void this.onTrackInfoChanged(context, ti); });
            if (settings.batteryDisplayMode !== 'off') {
                controller.registerBatteryCallback(context, (b) => this.onBatteryChanged(context, b));
            }

            const [transportState, track] = await Promise.all([
                controller.getTransportState(),
                controller.getCurrentTrack(),
            ]);

            const state = this.states.get(context)!;
            state.transportState = transportState;
            if (transportState === 'PLAYING') this.startAnimTimer(context);
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
                    const visibleColor = ensureVisibleColor(c);
                    const pk = panoramaContextGroupKey.get(context);
                    if (isPanoramaEffectActive(pk)) {
                        groupEffects.get(pk!)?.onSettingsChange?.({ color: visibleColor });
                    }
                    void this.renderDial(context);
                }).catch(() => {});

                const text = state.trackInfo.Title ?? '';
                await this.updateTitleMarquee(context, text, settings.fontSize ?? 14, this.marqWidth(settings), settings);
            }

            await this.renderDial(context);

        } catch (e) {
            streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
            await this.renderUnreachableDial(context, 'TRACK');
            this.scheduleSetupRetry(ev);
        }
    }

    protected cleanupInstance(context: string): void {
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            controller.unregisterBatteryCallback(context);
            controller.unregisterReachabilityCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }

        const animator = this.animators.get(context);
        if (animator) { animator.destroy(context); this.animators.delete(context); }

        marqueeAnimator.destroy(context);

        const mt = this.marqueeTimers.get(context);
        if (mt) { clearTimeout(mt); this.marqueeTimers.delete(context); }

        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    // Dial press → next track so the user can browse playlists.
    override async onDialDown(ev: DialDownEvent<TrackControlDialSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (!controller) return;
        try {
            await controller.next();
        } catch (e) {
            // e.g. UPnPError 701 "Transition not available" — a source that doesn't support
            // skipping (radio, empty queue). Must not propagate: an uncaught rejection here
            // crashes the entire plugin process (all devices/actions), not just this dial.
            streamDeck.logger.warn('next() failed', e);
        }
    }

    // Touch tap → toggle play / pause.
    override async onTouchTap(ev: TouchTapEvent<TrackControlDialSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (!controller) return;
        try {
            await controller.togglePlayPause();
        } catch (e) {
            streamDeck.logger.warn('togglePlayPause() failed', e);
        }
    }

    // Dial rotation → seek ±5 % per tick in the current track.
    override async onDialRotate(ev: DialRotateEvent<TrackControlDialSettings>): Promise<void> {
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
            await controller.transportDevice.AVTransportService.Seek({
                InstanceID: 0,
                Unit: 'REL_TIME',
                Target: formatRelTime(newPos),
            });
        } catch (e) {
            streamDeck.logger.warn('Seek failed', e);
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, TrackControlDialSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-devices': await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp); break;
            case 'get-viz-options':
                sendVizOptions(
                    { label: piT('None (track info only)'), value: 'none' },
                    { label: piT('EQ Effect'), value: 'eq' },
                );
                break;
            case 'get-battery-mode-options': sendBatteryModeOptions(); break;
        }
    }

    private async fetchAndStorePosition(context: string, controller: SonosDeviceController): Promise<void> {
        try {
            const pos = await controller.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
            const state = this.states.get(context);
            if (!state) return;
            state.trackPosition = parseRelTime(pos.RelTime);
            state.trackDuration = parseRelTime(pos.TrackDuration);
            state.trackPositionTime = Date.now();
        } catch { /* position stays at last known value */ }
    }

    private renderEqualizerBars(color: string, amplitude = 1): string {
        const base = [8, 14, 10, 18, 6, 12, 16, 8, 14, 10];
        return base.map((h, i) => {
            const full = Math.max(4, Math.min(18, h + Math.floor(Math.random() * 10 - 5)));
            const rh = Math.max(1, Math.round(full * amplitude));
            const op = (0.75 * amplitude).toFixed(2);
            return `<rect x="${8 + i * 9}" y="${90 - rh}" width="7" height="${rh}" fill="${escapeXml(color)}" opacity="${op}" rx="1"/>`;
        }).join('');
    }

    protected async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (!sdAction || !sdAction.isDial() || !state || !animator) return;

        const settings = this.settingsMap.get(context);

        // No device configured: show a minimal ready screen.
        if (!settings?.deviceIp) {
            const readySvg = buildUnconfiguredDialSvg('TRACK');
            const img = `data:image/svg+xml;base64,${Buffer.from(readySvg).toString('base64')}`;
            await sdAction.setFeedback({ 'full-canvas': img, 'title': '', 'indicator': { value: 0, enabled: false } }).catch(() => {});
            return;
        }

        const isPlaying = state.transportState === 'PLAYING';
        const isTransitioning = state.transportState === 'TRANSITIONING';
        const artist = state.trackInfo?.Artist ?? '';
        const accentColor = ensureVisibleColor(state.dominantColor);
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

        const batteryBadge = renderBatteryBadge(settings?.batteryDisplayMode, state.batteryStatus, 182, 10, 18);

        let svg: string;

        if (visualizerMode === 'none') {
            // 'left' anchor: the artwork square starts exactly at the cover slot (x=113) and its
            // overflow leaves the canvas on the right — never toward the text/progress bar. The
            // centered default started the image at x=106.5, visibly sliding under the progress
            // bar's end on hardware (same unclipped-image behavior as Queue Dial's cover shift).
            const sharpCover = animator.render(context, 113, 0, 87, 100, 'left');

            let titleFrag = '';
            if (settings?.showTrackTitle !== false) {
                if (marqueeAnimator.isRunning(context)) {
                    titleFrag = marqueeAnimator.render(context, 8, 72, 97, 20);
                } else {
                    const t = escapeXml(state.trackInfo?.Title ?? 'Sonos');
                    titleFrag = `<text x="8" y="72" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                }
            }

            svg = [
                '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                '<defs>',
                '  <clipPath id="textClip"><rect x="8" y="0" width="97" height="100"/></clipPath>',
                '  <clipPath id="coverClip"><rect x="113" y="0" width="87" height="100" rx="6"/></clipPath>',
                '</defs>',
                '<rect width="200" height="100" fill="black"/>',
                `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                titleFrag,
                `  <text x="8" y="86" fill="#999999" font-family="Arial,sans-serif" font-size="11">${escapeXml(artist)}</text>`,
                '</g>',
                `<rect x="8" y="95" width="97" height="5" fill="white" opacity="0.12" rx="2.5"/>`,
                progressPct > 0 ? `<rect x="8" y="95" width="${Math.round(97 * progress)}" height="5" fill="${escapeXml(accentColor)}" opacity="0.9" rx="2.5"/>` : '',
                `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                batteryBadge,
                '</svg>',
            ].join('');
        } else {
            // 'left' anchor: the artwork square starts exactly at the cover slot (x=113) and its
            // overflow leaves the canvas on the right — never toward the text/progress bar. The
            // centered default started the image at x=106.5, visibly sliding under the progress
            // bar's end on hardware (same unclipped-image behavior as Queue Dial's cover shift).
            const sharpCover = animator.render(context, 113, 0, 87, 100, 'left');

            let titleFrag = '';
            if (settings?.showTrackTitle !== false) {
                if (marqueeAnimator.isRunning(context)) {
                    titleFrag = marqueeAnimator.render(context, 8, 22, 97, 20);
                } else {
                    const t = escapeXml(state.trackInfo?.Title ?? 'Sonos');
                    titleFrag = `<text x="8" y="22" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                }
            }

            const rawPanoKey = this.isEffectMode(visualizerMode) ? panoramaContextGroupKey.get(context) : undefined;
            const panoramaKey = isPanoramaEffectActive(rawPanoKey) ? rawPanoKey : undefined;

            if (panoramaKey) {
                // Panorama mode: effect as full-canvas background; text layout same as 'none' (bottom-aligned).
                const sliceOffset = getPanoramaSliceOffset(context);
                const particleFrag = renderPanoramaEffectSlice(panoramaKey, sliceOffset);

                let panoTitleFrag = '';
                if (settings?.showTrackTitle !== false) {
                    if (marqueeAnimator.isRunning(context)) {
                        panoTitleFrag = marqueeAnimator.render(context, 8, 72, 97, 20);
                    } else {
                        const t = escapeXml(state.trackInfo?.Title ?? 'Sonos');
                        panoTitleFrag = `<text x="8" y="72" fill="${fontColor}" font-family="Arial,sans-serif" font-size="${fontSize}" clip-path="url(#textClip)">${t}</text>`;
                    }
                }

                // Text background pills — only as wide as the respective text.
                const titleText = state.trackInfo?.Title ?? '';
                const titlePillW = settings?.showTrackTitle !== false && titleText
                    ? Math.min(99, measureArialWidth(titleText, fontSize) + 8) : 0;
                const artistPillW = artist
                    ? Math.min(99, measureArialWidth(artist, 11) + 8) : 0;
                const titlePillY = Math.round(72 - fontSize * 0.8);
                const titlePillH = Math.round(fontSize * 1.1);

                svg = [
                    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                    '<defs>',
                    '  <clipPath id="c"><rect width="200" height="100"/></clipPath>',
                    '  <clipPath id="textClip"><rect x="8" y="0" width="97" height="100"/></clipPath>',
                    '  <clipPath id="coverClip"><rect x="113" y="0" width="87" height="100" rx="6"/></clipPath>',
                    '</defs>',
                    '<rect width="200" height="100" fill="#000"/>',
                    `<g clip-path="url(#c)">${particleFrag}</g>`,
                    titlePillW > 0 ? `<rect x="5" y="${titlePillY}" width="${titlePillW}" height="${titlePillH}" fill="black" opacity="0.55" rx="3"/>` : '',
                    artistPillW > 0 ? `<rect x="5" y="77" width="${artistPillW}" height="13" fill="black" opacity="0.55" rx="3"/>` : '',
                    `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                    panoTitleFrag,
                    `  <text x="8" y="86" fill="#999999" font-family="Arial,sans-serif" font-size="11">${escapeXml(artist)}</text>`,
                    '</g>',
                    `<rect x="8" y="95" width="97" height="5" fill="white" opacity="0.12" rx="2.5"/>`,
                    progressPct > 0 ? `<rect x="8" y="95" width="${Math.round(97 * progress)}" height="5" fill="${escapeXml(accentColor)}" opacity="0.9" rx="2.5"/>` : '',
                    `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                    batteryBadge,
                    '</svg>',
                ].join('');
            } else {
                // EQ layout (or a brief transient moment before an effect's group resolves):
                // dark background, visualizer bottom-left.
                const visualizer = isPlaying ? this.renderEqualizerBars(accentColor, eqAmplitude) : '';

                svg = [
                    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                    '<defs>',
                    '  <clipPath id="textClip"><rect x="8" y="2" width="97" height="96"/></clipPath>',
                    '  <clipPath id="coverClip"><rect x="113" y="0" width="87" height="100" rx="6"/></clipPath>',
                    '</defs>',
                    '<rect width="200" height="100" fill="black"/>',
                    `<g clip-path="url(#textClip)" opacity="${textOpacity}">`,
                    titleFrag,
                    `  <text x="8" y="38" fill="#999999" font-family="Arial,sans-serif" font-size="12">${escapeXml(artist)}</text>`,
                    '</g>',
                    `<rect x="8" y="48" width="97" height="5" fill="white" opacity="0.12" rx="2.5"/>`,
                    progressPct > 0 ? `<rect x="8" y="48" width="${Math.round(97 * progress)}" height="5" fill="${escapeXml(accentColor)}" opacity="0.9" rx="2.5"/>` : '',
                    visualizer,
                    `<g clip-path="url(#coverClip)">${sharpCover}</g>`,
                    batteryBadge,
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

}
