import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    SingletonAction,
    DialDownEvent,
    TouchTapEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { VolumeInfo } from "../sonos/SonosTypes";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { panoramaContextGroupKey, registerInPanorama, unregisterFromPanorama, getPanoramaSliceOffset, renderPanoramaEffectSlice, isPanoramaEffectActive, setContextEffectId, registerPanoramaRenderCallback, unregisterPanoramaRenderCallback } from "../effects/PanoramaOrchestrator";
import { effectRegistry } from "../effects/registry.generated";
import { mdiVolumeOff, mdiCheck } from "@mdi/js";
import { piT } from "../utils/pi-i18n";

// 'none' is not a registered effect — everything else is looked up in effectRegistry.
function isEffectMode(mode?: string): boolean {
    return !!mode && mode !== 'none';
}

type SonosDialVolumeSettings = {
    deviceIp?: string;
    presetVolume?: number;
    align?: 'left' | 'center' | 'right';
    showText?: boolean;
    // 'none' | any registered effect id (e.g. 'particles', 'boing-ball').
    visualizerMode?: string;
};

interface DialState {
    volume?: number;
    displayVolume?: number;
    isMuted?: boolean;
    deviceName?: string;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-volume" })
export class SonosDialVolume extends SingletonAction<SonosDialVolumeSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, DialState> = new Map();
    private settingsMap: Map<string, SonosDialVolumeSettings> = new Map();
    private animTimers: Map<string, NodeJS.Timeout> = new Map();
    private contextColumns: Map<string, number> = new Map();
    private rotateSend: Map<string, { target: number; timer?: NodeJS.Timeout; sending: boolean; resendNeeded: boolean; lastSentAt: number }> = new Map();
    private feedbackSuppressUntil: Map<string, number> = new Map();
    private volumeAnimTimers: Map<string, NodeJS.Timeout> = new Map();
    private presetSavedUntil: Map<string, number> = new Map();

    private static readonly SEND_THROTTLE_MS = 120;
    private static readonly PRESET_SAVED_FLASH_MS = 500;

    // Brief on-device confirmation that a long-touch preset save succeeded — dial actions have
    // no showOk()/showAlert()-style flash for this, so swap the pie for a checkmark momentarily.
    private flashPresetSaved(context: string): void {
        this.presetSavedUntil.set(context, Date.now() + SonosDialVolume.PRESET_SAVED_FLASH_MS);
        void this.renderDial(context);
        setTimeout(() => {
            this.presetSavedUntil.delete(context);
            void this.renderDial(context);
        }, SonosDialVolume.PRESET_SAVED_FLASH_MS);
    }

    private onVolumeInfoChanged(context: string, volumeInfo: VolumeInfo): void {
        // While the user is actively turning the dial, our own optimistic value is more
        // current than feedback echoed back from Sonos (which can arrive out of order
        // relative to the rapid-fire SetVolume calls and briefly report a stale volume).
        if (Date.now() < (this.feedbackSuppressUntil.get(context) ?? 0)) return;
        const state = this.states.get(context);
        if (state) {
            state.volume = volumeInfo.volume;
            state.isMuted = volumeInfo.mute;
            this.startVolumeAnim(context);
            void this.renderDial(context);
        }
    }

    // Eases the pie icon toward state.volume instead of snapping to it on every tick,
    // so rapid rotation reads as smooth motion rather than discrete jumps.
    private startVolumeAnim(context: string): void {
        if (this.volumeAnimTimers.has(context)) return;
        const timer = setInterval(() => {
            const state = this.states.get(context);
            if (!state || state.volume === undefined) { this.stopVolumeAnim(context); return; }
            const target = state.volume;
            const current = state.displayVolume ?? target;
            const diff = target - current;
            if (Math.abs(diff) < 0.3) {
                state.displayVolume = target;
                this.stopVolumeAnim(context);
            } else {
                state.displayVolume = current + diff * 0.4;
            }
            void this.renderDial(context);
        }, 25);
        this.volumeAnimTimers.set(context, timer);
    }

    private stopVolumeAnim(context: string): void {
        const timer = this.volumeAnimTimers.get(context);
        if (timer) { clearInterval(timer); this.volumeAnimTimers.delete(context); }
    }

    // Throttled (not debounced): during continuous rotation a send must go out roughly every
    // SEND_THROTTLE_MS so the actual Sonos volume keeps pace, instead of only jumping once
    // the user stops turning (which reads as "very slow" to react while spinning fast).
    private scheduleVolumeSend(context: string, controller: SonosDeviceController, target: number): void {
        let entry = this.rotateSend.get(context);
        if (!entry) {
            entry = { target, sending: false, resendNeeded: false, lastSentAt: 0 };
            this.rotateSend.set(context, entry);
        } else {
            entry.target = target;
        }

        if (entry.sending) {
            entry.resendNeeded = true;
            return;
        }

        const elapsed = Date.now() - entry.lastSentAt;
        if (elapsed >= SonosDialVolume.SEND_THROTTLE_MS) {
            if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
            void this.flushVolumeSend(context, controller);
        } else if (!entry.timer) {
            entry.timer = setTimeout(() => void this.flushVolumeSend(context, controller), SonosDialVolume.SEND_THROTTLE_MS - elapsed);
        }
        // else: a timer is already scheduled and will pick up the latest entry.target when it fires.
    }

    private async flushVolumeSend(context: string, controller: SonosDeviceController): Promise<void> {
        const entry = this.rotateSend.get(context);
        if (!entry) return;
        entry.timer = undefined;
        entry.sending = true;
        entry.resendNeeded = false;
        entry.lastSentAt = Date.now();
        const target = entry.target;
        try {
            await controller.setVolume(target);
        } catch (e) {
            streamDeck.logger.error(`SonosDialVolume: error setting volume for ${context}`, e);
        } finally {
            entry.sending = false;
            this.feedbackSuppressUntil.set(context, Date.now() + 800);
            if (entry.resendNeeded) {
                this.scheduleVolumeSend(context, controller, entry.target);
            }
        }
    }

    // While in an active effect group (grouped or solo singleton), the shared tick's render
    // callback drives rendering instead — this timer just keeps the interval alive and skips its
    // own render call, avoiding two independent, potentially out-of-phase render sources for the
    // same effect (that caused a brief "mirrored"/desynced look every few bounces).
    private startAnimTimer(context: string): void {
        if (this.animTimers.has(context)) return;
        const timer = setInterval(() => {
            const settings = this.settingsMap.get(context);
            if (!isEffectMode(settings?.visualizerMode)) { this.stopAnimTimer(context); return; }
            const inPanorama = isPanoramaEffectActive(panoramaContextGroupKey.get(context));
            if (!inPanorama) void this.renderDial(context);
        }, 50);
        this.animTimers.set(context, timer);
    }

    private stopAnimTimer(context: string): void {
        const timer = this.animTimers.get(context);
        if (timer) { clearInterval(timer); this.animTimers.delete(context); }
    }

    private cleanupInstance(context: string): void {
        unregisterFromPanorama(context);
        unregisterPanoramaRenderCallback(context);
        this.stopAnimTimer(context);
        const oldController = this.controllers.get(context);
        if (oldController) {
            oldController.unregisterVolumeCallback(context);
            sonosDeviceManager.releaseController(oldController.deviceIp);
            this.controllers.delete(context);
        }
        this.states.delete(context);
        this.settingsMap.delete(context);
        const rotateEntry = this.rotateSend.get(context);
        if (rotateEntry?.timer) clearTimeout(rotateEntry.timer);
        this.rotateSend.delete(context);
        this.feedbackSuppressUntil.delete(context);
        this.stopVolumeAnim(context);
        this.presetSavedUntil.delete(context);
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosDialVolumeSettings> | DidReceiveSettingsEvent<SonosDialVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;

        this.cleanupInstance(context);
        this.settingsMap.set(context, settings);
        this.states.set(context, {});

        if (!settings.deviceIp) {
            void this.renderDial(context);
            return;
        }

        if (isEffectMode(settings.visualizerMode)) {
            // Register in the shared panorama system — an adjacent dial wanting the SAME effect
            // merges into one shared instance; otherwise this renders its own effect solo (a
            // "group" of one is exactly how solo rendering works, see PanoramaOrchestrator).
            registerInPanorama(context, this.contextColumns.get(context) ?? 0);
            setContextEffectId(context, settings.visualizerMode!);
            registerPanoramaRenderCallback(context, () => this.renderDial(context));
            this.startAnimTimer(context);
        }

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);
            controller.registerVolumeCallback(context, (vi: VolumeInfo) => this.onVolumeInfoChanged(context, vi));

            const [zone, vol] = await Promise.all([controller.getZoneAttributes(), controller.getVolume()]);
            const state = this.states.get(context);
            if (state) {
                state.deviceName = zone.CurrentZoneName;
                state.volume = vol.volume;
                state.displayVolume = vol.volume;
                state.isMuted = vol.mute;
            }
            void this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`SonosDialVolume: error getting initial state for ${settings.deviceIp}`, e);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosDialVolumeSettings>): Promise<void> {
        const col = 'coordinates' in ev.payload ? (ev.payload.coordinates as { column: number }).column : 0;
        this.contextColumns.set(ev.action.id, col);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosDialVolumeSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosDialVolumeSettings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
        this.contextColumns.delete(ev.action.id);
    }

    override async onDialDown(ev: DialDownEvent<SonosDialVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;
        // Use the resolved new-mute value directly instead of waiting for the device's own
        // echo (UPnP event or next poll tick) to update the icon — that echo can lag by several
        // seconds, while toggleMute()'s own SOAP round trip resolves almost immediately.
        state.isMuted = await controller.toggleMute();
        void this.renderDial(context);
    }

    override async onTouchTap(ev: TouchTapEvent<SonosDialVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (!controller) return;

        if (ev.payload.hold) {
            // Long touch: save the current volume as the new preset.
            const state = this.states.get(context);
            if (state?.volume === undefined) return;
            const settings: SonosDialVolumeSettings = { ...ev.payload.settings, presetVolume: state.volume };
            this.settingsMap.set(context, settings);
            await ev.action.setSettings(settings);
            this.flashPresetSaved(context);
            return;
        }

        await controller.setVolume(ev.payload.settings.presetVolume ?? 50);
    }

    override async onDialRotate(ev: DialRotateEvent<SonosDialVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state || state.volume === undefined) return;

        if (state.isMuted) await controller.toggleMute();

        const ticks = ev.payload.ticks;
        const isFastSpin = Math.abs(ticks) > 3;
        const newVolume = Math.min(100, Math.max(0, state.volume + ticks * (isFastSpin ? 2 : 1)));
        if (newVolume !== state.volume) {
            state.volume = newVolume;
            if (isFastSpin) {
                // Large per-event jump (Stream Deck already coalesced several detents into
                // this one tick) — ease the pie toward it instead of snapping.
                this.startVolumeAnim(context);
            } else {
                // Normal single-detent turn — snap instantly, no catch-up lag.
                this.stopVolumeAnim(context);
                state.displayVolume = newVolume;
            }
            void this.renderDial(context);
            // Suppress immediately so an in-flight echo from a previous tick can't
            // clobber this optimistic value before our own send completes.
            this.feedbackSuppressUntil.set(context, Date.now() + 800);
            this.scheduleVolumeSend(context, controller, newVolume);
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosDialVolumeSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;
                const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- Choose Device --', value: '' }, ...items],
                });
            }
            if (ev.payload.event === 'get-align-options') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-align-options',
                    items: [
                        { label: piT('Left'), value: 'left' },
                        { label: piT('Center'), value: 'center' },
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

    private buildTextParts(cx: number, cy: number, volume: number, isMuted: boolean, deviceName: string, align: string, showText: boolean): string[] {
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

        const name = deviceName.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
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

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction?.isDial()) return;

        const settings = this.settingsMap.get(context);
        const state = this.states.get(context);
        const align = settings?.align ?? 'left';
        const showText = settings?.showText ?? true;
        const visualizerMode = settings?.visualizerMode ?? 'none';

        if (!settings?.deviceIp) {
            const svg = [
                '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
                '<rect width="200" height="100" fill="#0a0a0a"/>',
                '<text x="100" y="48" fill="#2a2a2a" font-family="Arial,sans-serif" font-size="34" text-anchor="middle">♪</text>',
                '<text x="100" y="68" fill="#333" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" letter-spacing="2">SONOS</text>',
                '</svg>',
            ].join('');
            await sdAction.setFeedback({
                'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
            }).catch(() => {});
            return;
        }

        const volume = state?.volume ?? 0;
        const displayVolume = state?.displayVolume ?? volume;
        const isMuted = state?.isMuted ?? false;
        const deviceName = state?.deviceName ?? '';
        const cx = align === 'center' ? 100 : align === 'right' ? 150 : 50;
        const cy = 50;

        const showSavedFlash = (this.presetSavedUntil.get(context) ?? 0) > Date.now();
        const pieParts = showSavedFlash
            ? this.buildSavedIcon(cx, cy)
            : this.buildPieParts(cx, cy, displayVolume, isMuted, '#CCCCCC');
        const textParts = this.buildTextParts(cx, cy, volume, isMuted, deviceName, align, showText);

        const rawPanoramaKey = isEffectMode(visualizerMode) ? panoramaContextGroupKey.get(context) : undefined;
        const panoramaKey = isPanoramaEffectActive(rawPanoramaKey) ? rawPanoramaKey : undefined;
        const particleFrag = panoramaKey ? renderPanoramaEffectSlice(panoramaKey, getPanoramaSliceOffset(context)) : '';
        const hasParticles = !!panoramaKey;
        const svgParts: string[] = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        ];

        if (hasParticles) {
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
