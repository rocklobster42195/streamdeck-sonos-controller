import streamDeck, {
    DialRotateEvent,
    WillAppearEvent,
    DialDownEvent,
    DidReceiveSettingsEvent,
} from "@elgato/streamdeck";
import { PanoramaCapableDialAction, PanoramaCapableSettings } from "./PanoramaCapableDialAction";
import { VolumeInfo } from "../sonos/SonosTypes";
import { FadeDisplayAnimator } from "../utils/FadeDisplayAnimator";
import { panoramaContextGroupKey, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive } from "../effects/PanoramaOrchestrator";
import { mdiVolumeOff, mdiCheck } from "@mdi/js";
import { buildUnconfiguredDialSvg } from "../utils/icons";
import { escapeXml } from "../utils/xml";

// Everything Volume Dial and Group Volume Dial both need from their controller — structural, so
// SonosDeviceController and SonosGroupController each satisfy it without a common base class.
export interface VolumePieController {
    toggleMute(): Promise<boolean>;
    getVolume(): Promise<VolumeInfo>;
    registerVolumeCallback(id: string, cb: (volumeInfo: VolumeInfo) => void): void;
    unregisterVolumeCallback(id: string): void;
    registerFadeStateCallback(id: string, cb: (fading: boolean, durationMs: number) => void): void;
    unregisterFadeStateCallback(id: string): void;
    registerReachabilityCallback(id: string, cb: (reachable: boolean) => void): void;
    unregisterReachabilityCallback(id: string): void;
    readonly isReachable: boolean;
}

export type VolumePieDialSettings = PanoramaCapableSettings & {
    align?: 'left' | 'center' | 'right';
    showText?: boolean;
};

interface PieDialState {
    isMuted?: boolean;
    // Zone name (Volume Dial) / group name (Group Volume Dial) shown under the % text.
    displayName?: string;
    // Owns target/display volume plus the fade fake-animation — see FadeDisplayAnimator.
    anim: FadeDisplayAnimator;
}

/**
 * Shared core of Volume Dial and Group Volume Dial — the two were byte-identical except for
 * which controller they drive, how a rotation is sent (absolute target vs. accumulated delta,
 * see queueRotationSend) and what a preset stores (single volume vs. per-member snapshot, see
 * each subclass's onTouchTap). Owns display state, echo suppression, the fade/ease animation,
 * and the pie/text/panorama SVG rendering.
 */
export abstract class VolumePieDialAction<
    TController extends VolumePieController,
    TSettings extends VolumePieDialSettings,
> extends PanoramaCapableDialAction<TSettings> {
    protected controllers: Map<string, TController> = new Map();
    protected states: Map<string, PieDialState> = new Map();
    protected feedbackSuppressUntil: Map<string, number> = new Map();
    private presetSavedUntil: Map<string, number> = new Map();

    protected static readonly SEND_THROTTLE_MS = 120;
    private static readonly PRESET_SAVED_FLASH_MS = 500;
    // After an optimistic local write, ignore device-echoed volume feedback for this long — it
    // can arrive late/out-of-order relative to rapid-fire sends and briefly report a stale value.
    protected static readonly FEEDBACK_SUPPRESS_MS = 800;

    /** Label on the unconfigured/unreachable placeholder ('VOLUME' / 'GROUP'). */
    protected abstract readonly dialLabel: string;
    /** The configured target id (deviceIp / groupIp), or undefined when not yet configured. */
    protected abstract configuredId(settings: TSettings): string | undefined;
    protected abstract acquireController(id: string): Promise<TController>;
    protected abstract releaseController(controller: TController): void;
    /** Name shown under the % text (zone name / group name). */
    protected abstract fetchDisplayName(controller: TController): Promise<string> | string;
    /**
     * Throttled network send for a rotation step. Volume Dial sends the absolute target; Group
     * Volume Dial accumulates deltas (so the send never depends on a cached baseline that could
     * go stale mid-rotation) — hence the hook gets both values.
     */
    protected abstract queueRotationSend(context: string, controller: TController, oldVolume: number, newVolume: number): void;
    /** Clear any pending rotation-send timer for this context (cleanup path). */
    protected abstract clearRotationSend(context: string): void;

    // Brief on-device confirmation that a long-touch preset save succeeded — dial actions have
    // no showOk()/showAlert()-style flash for this, so swap the pie for a checkmark momentarily.
    protected flashPresetSaved(context: string): void {
        this.presetSavedUntil.set(context, Date.now() + VolumePieDialAction.PRESET_SAVED_FLASH_MS);
        void this.renderDial(context);
        setTimeout(() => {
            this.presetSavedUntil.delete(context);
            void this.renderDial(context);
        }, VolumePieDialAction.PRESET_SAVED_FLASH_MS);
    }

    private onVolumeInfoChanged(context: string, volumeInfo: VolumeInfo): void {
        // While the user is actively turning the dial, our own optimistic value is more current
        // than feedback echoed back from Sonos — see FEEDBACK_SUPPRESS_MS.
        if (Date.now() < (this.feedbackSuppressUntil.get(context) ?? 0)) return;
        const state = this.states.get(context);
        if (!state) return;
        state.isMuted = volumeInfo.mute;
        state.anim.onEcho(volumeInfo.volume);
        // During a fade the animator owns the display — real echoes are the coarse steps the
        // fake descent exists to hide; the target still tracks reality underneath.
        if (!state.anim.isFading) void this.renderDial(context);
    }

    protected cleanupInstance(context: string): void {
        const oldController = this.controllers.get(context);
        if (oldController) {
            oldController.unregisterVolumeCallback(context);
            oldController.unregisterFadeStateCallback(context);
            oldController.unregisterReachabilityCallback(context);
            this.releaseController(oldController);
            this.controllers.delete(context);
        }
        this.states.get(context)?.anim.stop();
        this.states.delete(context);
        this.settingsMap.delete(context);
        this.clearRotationSend(context);
        this.feedbackSuppressUntil.delete(context);
        this.presetSavedUntil.delete(context);
    }

    protected hasLiveInstance(context: string): boolean {
        return this.controllers.has(context);
    }

    protected override async onInstanceUpdate(ev: WillAppearEvent<TSettings> | DidReceiveSettingsEvent<TSettings>): Promise<void> {
        const context = ev.action.id;
        let settings = ev.payload.settings;

        this.cleanupInstance(context);

        // `showText` defaults to true in renderDial below (`settings?.showText ?? true`), but the
        // PI checkbox's own "unset" default is unchecked — persist the real default here too so
        // the two stay in sync (a brand new tile otherwise shows the % text with an unchecked box).
        settings = this.applyBackfill(ev, settings, { showText: true } as unknown as Partial<TSettings>);

        this.settingsMap.set(context, settings);
        this.states.set(context, { anim: new FadeDisplayAnimator(() => void this.renderDial(context)) });

        const id = this.configuredId(settings);
        if (!id) {
            this.leavePanorama(context);
            void this.renderDial(context);
            return;
        }

        this.syncPanoramaParticipation(context, settings);

        try {
            const controller = await this.acquireController(id);
            this.controllers.set(context, controller);
            // Bails out if the device was already unreachable at registration — the placeholder
            // that just showed would otherwise be immediately overwritten by the unconditional
            // renderDial below, which (for GroupVolumeDial specifically) has no network call of
            // its own to naturally fail on first (see registerReachabilityHandling's doc comment).
            if (!this.registerReachabilityHandling(controller, ev, this.dialLabel)) return;
            controller.registerVolumeCallback(context, (vi: VolumeInfo) => this.onVolumeInfoChanged(context, vi));
            controller.registerFadeStateCallback(context, (fading, durationMs) => this.states.get(context)?.anim.onFadeState(fading, durationMs));

            const [name, vol] = await Promise.all([
                Promise.resolve(this.fetchDisplayName(controller)),
                controller.getVolume(),
            ]);
            const state = this.states.get(context);
            if (state) {
                state.displayName = name;
                state.anim.initialize(vol.volume);
                state.isMuted = vol.mute;
            }
            void this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`${this.constructor.name}: error getting initial state for ${id}`, e);
            await this.renderUnreachableDial(context, this.dialLabel);
            this.scheduleSetupRetry(ev);
        }
    }

    override async onDialDown(ev: DialDownEvent<TSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;
        // Use the resolved new-mute value directly instead of waiting for the device's own echo
        // (UPnP event or next poll tick) to update the icon — that echo can lag by seconds,
        // while toggleMute()'s own SOAP round trip resolves almost immediately.
        state.isMuted = await controller.toggleMute();
        void this.renderDial(context);
    }

    override async onDialRotate(ev: DialRotateEvent<TSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state || state.anim.targetVolume === undefined) return;

        if (state.isMuted) await controller.toggleMute();

        const ticks = ev.payload.ticks;
        const isFastSpin = Math.abs(ticks) > 3;
        const oldVolume = state.anim.targetVolume;
        const newVolume = Math.min(100, Math.max(0, oldVolume + ticks * (isFastSpin ? 2 : 1)));
        if (newVolume === oldVolume) return;

        // Fast spin: Stream Deck already coalesced several detents into this one tick — ease the
        // pie toward the large jump. Normal single-detent turn: snap instantly, no catch-up lag.
        state.anim.setTarget(newVolume, isFastSpin);
        void this.renderDial(context);
        // Suppress immediately so an in-flight echo from a previous tick can't clobber this
        // optimistic value before our own send completes.
        this.feedbackSuppressUntil.set(context, Date.now() + VolumePieDialAction.FEEDBACK_SUPPRESS_MS);
        this.queueRotationSend(context, controller, oldVolume, newVolume);
    }

    // --- Rendering ---

    private buildPieParts(cx: number, cy: number, volume: number, isMuted: boolean, color: string): string[] {
        const rOuter = 38;
        const rInner = 30;

        if (isMuted) {
            const size = rOuter * 2;
            const scale = size / 24;
            return [`<g transform="translate(${cx - rOuter},${cy - rOuter}) scale(${scale.toFixed(3)})"><path fill="${color}" d="${mdiVolumeOff}"/></g>`];
        }

        const percent = Math.max(0, Math.min(volume, 100));
        const parts: string[] = [
            `<circle cx="${cx}" cy="${cy}" r="${rOuter}" stroke="${color}" stroke-width="6" fill="none"/>`,
        ];

        if (percent >= 99.9) {
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="${color}"/>`);
        } else if (percent > 0.1) {
            const angleDeg = (percent / 100) * 360;
            const angleRad = (angleDeg - 90) * (Math.PI / 180);
            const xEnd = cx + rInner * Math.cos(angleRad);
            const yEnd = cy + rInner * Math.sin(angleRad);
            const largeArc = angleDeg > 180 ? 1 : 0;
            parts.push(`<path d="M ${cx} ${cy} L ${cx} ${cy - rInner} A ${rInner} ${rInner} 0 ${largeArc} 1 ${xEnd.toFixed(2)} ${yEnd.toFixed(2)} Z" fill="${color}"/>`);
        }
        return parts;
    }

    private buildSavedIcon(cx: number, cy: number): string[] {
        const rOuter = 38;
        const size = rOuter * 2;
        const scale = size / 24;
        return [`<g transform="translate(${cx - rOuter},${cy - rOuter}) scale(${scale.toFixed(3)})"><path fill="#4CAF50" d="${mdiCheck}"/></g>`];
    }

    private buildTextParts(cx: number, cy: number, volume: number, isMuted: boolean, displayName: string, align: string, showText: boolean): string[] {
        if (!showText) return [];

        const volumeText = isMuted ? 'MUTE' : `${volume}%`;

        // Text can sit on top of the pie itself (center alignment) or the particle background
        // (any alignment) rather than always on plain dark canvas — give it its own translucent
        // chip so it stays legible regardless, same pattern as the track title/artist overlays
        // in the panorama particles background.
        if (align === 'center') {
            const chipW = 60, chipH = 26;
            return [
                `<rect x="${cx - chipW / 2}" y="${cy - chipH / 2}" width="${chipW}" height="${chipH}" rx="4" fill="#000" fill-opacity="0.6"/>`,
                `<text x="${cx}" y="${cy + 6}" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${volumeText}</text>`,
            ];
        }

        const name = escapeXml(displayName);
        const textX = align === 'right' ? 55 : 145;
        const chipW = 90;
        const chipH = name ? 42 : 26;
        const chipY = name ? cy - 18 : cy - 13;
        const parts: string[] = [
            `<rect x="${textX - chipW / 2}" y="${chipY}" width="${chipW}" height="${chipH}" rx="4" fill="#000" fill-opacity="0.6"/>`,
            `<text x="${textX}" y="${cy - 4}" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${volumeText}</text>`,
        ];
        if (name) parts.push(`<text x="${textX}" y="${cy + 14}" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="11" text-anchor="middle">${name}</text>`);
        return parts;
    }

    protected async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction?.isDial()) return;

        const settings = this.settingsMap.get(context);
        const state = this.states.get(context);
        const align = settings?.align ?? 'left';
        const showText = settings?.showText ?? true;
        const visualizerMode = settings?.visualizerMode ?? 'none';

        if (!settings || !this.configuredId(settings)) {
            const svg = buildUnconfiguredDialSvg(this.dialLabel);
            await sdAction.setFeedback({
                'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
            }).catch(() => {});
            return;
        }

        const volume = state?.anim.targetVolume ?? 0;
        const displayVolume = state?.anim.current() ?? 0;
        const isMuted = state?.isMuted ?? false;
        const displayName = state?.displayName ?? '';
        const cx = align === 'center' ? 100 : align === 'right' ? 150 : 50;
        const cy = 50;

        const showSavedFlash = (this.presetSavedUntil.get(context) ?? 0) > Date.now();
        const pieParts = showSavedFlash
            ? this.buildSavedIcon(cx, cy)
            : this.buildPieParts(cx, cy, displayVolume, isMuted, '#CCCCCC');
        const textParts = this.buildTextParts(cx, cy, volume, isMuted, displayName, align, showText);

        const rawPanoramaKey = this.isEffectMode(visualizerMode) ? panoramaContextGroupKey.get(context) : undefined;
        const panoramaKey = isPanoramaEffectActive(rawPanoramaKey) ? rawPanoramaKey : undefined;
        const particleFrag = panoramaKey ? renderPanoramaEffectSlice(panoramaKey, getPanoramaSliceOffset(context)) : '';
        const svgParts: string[] = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        ];

        if (panoramaKey) {
            svgParts.push(
                '<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs>',
                '<rect width="200" height="100" fill="#000"/>',
                `<g clip-path="url(#c)">${particleFrag}</g>`,
            );
        } else {
            svgParts.push('<rect width="200" height="100" fill="#0a0a0a"/>');
        }

        svgParts.push(...pieParts, ...textParts, '</svg>');

        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svgParts.join('')).toString('base64')}`,
        }).catch(() => {});
    }
}
