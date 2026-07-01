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
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { particleEngine } from "../utils/ParticleEngine";
import { panoramaContextGroupKey, registerInPanorama, unregisterFromPanorama, getPanoramaSliceOffset } from "./sonos-dial-particles";
import { mdiVolumeOff } from "@mdi/js";
import { piT } from "../utils/pi-i18n";

type Settings = {
    deviceIp?: string;
    presetVolume?: number;
    align?: 'left' | 'center' | 'right';
    showText?: boolean;
    visualizerMode?: 'none' | 'particles';
    particleCount?: number;
    particleSpeed?: number;
};

interface DialState {
    volume: number;
    isMuted: boolean;
    groupName: string;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-group-volume" })
export class SonosDialGroupVolume extends SingletonAction<Settings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private listeners: Map<string, (evt: any) => void> = new Map();
    private states: Map<string, DialState> = new Map();
    private settingsMap: Map<string, Settings> = new Map();
    private animTimers: Map<string, NodeJS.Timeout> = new Map();
    private contextColumns: Map<string, number> = new Map();

    private startAnimTimer(context: string): void {
        if (this.animTimers.has(context)) return;
        const timer = setInterval(() => {
            const settings = this.settingsMap.get(context);
            if (settings?.visualizerMode !== 'particles') { this.stopAnimTimer(context); return; }
            if (!panoramaContextGroupKey.get(context)) particleEngine.tick(context);
            void this.renderDial(context);
        }, 100);
        this.animTimers.set(context, timer);
    }

    private stopAnimTimer(context: string): void {
        const timer = this.animTimers.get(context);
        if (timer) { clearInterval(timer); this.animTimers.delete(context); }
    }

    private cleanupInstance(context: string): void {
        unregisterFromPanorama(context);
        this.stopAnimTimer(context);
        particleEngine.destroy(context);
        const controller = this.controllers.get(context);
        if (controller) {
            const listener = this.listeners.get(context);
            if (listener) {
                controller.sonosDevice.GroupRenderingControlService.Events.removeListener('serviceEvent', listener);
                this.listeners.delete(context);
            }
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }
        this.states.delete(context);
        this.settingsMap.delete(context);
    }

    async onInstanceUpdate(ev: WillAppearEvent<Settings> | DidReceiveSettingsEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;

        this.cleanupInstance(context);
        this.settingsMap.set(context, settings);
        this.states.set(context, { volume: 0, isMuted: false, groupName: '' });

        if (!settings.deviceIp) {
            void this.renderDial(context);
            return;
        }

        if (settings.visualizerMode === 'particles') {
            particleEngine.init(context, {
                width: 200, height: 100, color: '#CCCCCC',
                mode: 'network', connectDistance: 50,
                minRadius: 1.5, maxRadius: 3, opacity: 0.85,
                count: settings.particleCount ?? 20,
                maxSpeed: settings.particleSpeed != null ? settings.particleSpeed / 10 : 0.4,
            });
            registerInPanorama(context, this.contextColumns.get(context) ?? 0);
            this.startAnimTimer(context);
        }

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            const listener = (evt: any) => {
                const s = this.states.get(context);
                if (!s) return;
                if (evt.GroupVolume !== undefined) s.volume = evt.GroupVolume;
                if (evt.GroupMute !== undefined) s.isMuted = !!evt.GroupMute;
                void this.renderDial(context);
            };
            this.listeners.set(context, listener);
            controller.sonosDevice.GroupRenderingControlService.Events.on('serviceEvent', listener);

            const [groupVol, groupMute, zone] = await Promise.all([
                controller.sonosDevice.GroupRenderingControlService.GetGroupVolume({ InstanceID: 0 }),
                controller.sonosDevice.GroupRenderingControlService.GetGroupMute({ InstanceID: 0 }),
                controller.getZoneAttributes(),
            ]);

            const state = this.states.get(context);
            if (state) {
                state.volume = groupVol.CurrentVolume;
                state.isMuted = !!groupMute.CurrentMute;
                state.groupName = zone.CurrentZoneName;
            }
            void this.renderDial(context);
        } catch (e) {
            streamDeck.logger.error(`SonosDialGroupVolume: error for ${settings.deviceIp}`, e);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
        const col = 'coordinates' in ev.payload ? (ev.payload.coordinates as { column: number }).column : 0;
        this.contextColumns.set(ev.action.id, col);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
        this.contextColumns.delete(ev.action.id);
    }

    override async onDialDown(ev: DialDownEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;
        try {
            await controller.sonosDevice.GroupRenderingControlService.SetGroupMute({
                InstanceID: 0,
                DesiredMute: !state.isMuted,
            });
        } catch (e) {
            streamDeck.logger.warn('SetGroupMute failed', e);
        }
    }

    override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (!controller) return;
        try {
            await controller.sonosDevice.GroupRenderingControlService.SetGroupVolume({
                InstanceID: 0,
                DesiredVolume: ev.payload.settings.presetVolume ?? 50,
            });
        } catch (e) {
            streamDeck.logger.warn('SetGroupVolume (preset) failed', e);
        }
    }

    override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;

        if (state.isMuted) {
            try {
                await controller.sonosDevice.GroupRenderingControlService.SetGroupMute({ InstanceID: 0, DesiredMute: false });
                state.isMuted = false;
            } catch { /* ignore */ }
        }

        const delta = ev.payload.ticks * (Math.abs(ev.payload.ticks) > 3 ? 2 : 1);
        state.volume = Math.min(100, Math.max(0, state.volume + delta));
        void this.renderDial(context);

        try {
            const result = await controller.sonosDevice.GroupRenderingControlService.SetRelativeGroupVolume({
                InstanceID: 0,
                Adjustment: delta,
            });
            const s = this.states.get(context);
            if (s) s.volume = result.NewVolume;
        } catch (e) {
            streamDeck.logger.warn('SetRelativeGroupVolume failed', e);
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        if (ev.payload.event === 'get-devices') {
            await discoveryPromise;
            const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
            streamDeck.ui.sendToPropertyInspector({
                event: 'get-devices',
                items: [{ label: '-- Choose Device --', value: '' }, ...items],
            });
        }
        if (ev.payload.event === 'get-particle-state') {
            streamDeck.ui.sendToPropertyInspector({
                event: 'particle-state',
                inPanorama: !!panoramaContextGroupKey.get(ev.action.id),
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
                    { label: piT('Particles'), value: 'particles' },
                ],
            });
        }
    }

    private buildPieParts(cx: number, cy: number, volume: number, isMuted: boolean, color: string): string[] {
        const rOuter = 38, rInner = 30;
        if (isMuted) {
            const scale = (rOuter * 2) / 24;
            return [`<g transform="translate(${cx - rOuter},${cy - rOuter}) scale(${scale.toFixed(3)})"><path fill="${color}" d="${mdiVolumeOff}"/></g>`];
        }
        const percent = Math.max(0, Math.min(volume, 100));
        const parts: string[] = [`<circle cx="${cx}" cy="${cy}" r="${rOuter}" stroke="${color}" stroke-width="6" fill="none"/>`];
        if (percent >= 99.9) {
            parts.push(`<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="${color}"/>`);
        } else if (percent > 0.1) {
            const angleRad = ((percent / 100) * 360 - 90) * (Math.PI / 180);
            const xEnd = cx + rInner * Math.cos(angleRad);
            const yEnd = cy + rInner * Math.sin(angleRad);
            const largeArc = percent > 50 ? 1 : 0;
            parts.push(`<path d="M ${cx} ${cy} L ${cx} ${cy - rInner} A ${rInner} ${rInner} 0 ${largeArc} 1 ${xEnd.toFixed(2)} ${yEnd.toFixed(2)} Z" fill="${color}"/>`);
        }
        return parts;
    }

    private buildTextParts(cx: number, volume: number, isMuted: boolean, groupName: string, align: string, showText: boolean): string[] {
        if (align === 'center' || !showText) return [];
        const esc = (s: string) => s.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
        const textX = align === 'right' ? 55 : 145;
        const label = isMuted ? 'MUTE' : `${volume}%`;
        const parts = [`<text x="${textX}" y="46" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${label}</text>`];
        if (groupName) parts.push(`<text x="${textX}" y="64" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="11" text-anchor="middle">${esc(groupName)}</text>`);
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
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
                + '<rect width="200" height="100" fill="#0a0a0a"/>'
                + '<text x="100" y="48" fill="#2a2a2a" font-family="Arial,sans-serif" font-size="34" text-anchor="middle">♪</text>'
                + '<text x="100" y="68" fill="#333" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" letter-spacing="2">SONOS</text>'
                + '</svg>';
            await sdAction.setFeedback({ 'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` }).catch(() => {});
            return;
        }

        const volume = state?.volume ?? 0;
        const isMuted = state?.isMuted ?? false;
        const groupName = state?.groupName ?? '';
        const cx = align === 'center' ? 100 : align === 'right' ? 150 : 50;

        const panoramaKey = visualizerMode === 'particles' ? panoramaContextGroupKey.get(context) : undefined;
        const standaloneParticles = visualizerMode === 'particles' && !panoramaKey;
        let particleFrag = '';
        if (panoramaKey) {
            particleFrag = particleEngine.renderPanoramaSlice(panoramaKey, getPanoramaSliceOffset(context));
        } else if (standaloneParticles) {
            particleFrag = particleEngine.render(context, 0, 0);
        }

        const svgParts: string[] = ['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'];
        if (panoramaKey || standaloneParticles) {
            svgParts.push(
                '<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs>',
                '<rect width="200" height="100" fill="#000"/>',
                `<g clip-path="url(#c)">${particleFrag}</g>`,
            );
        } else {
            svgParts.push('<rect width="200" height="100" fill="#0a0a0a"/>');
        }
        svgParts.push(
            ...this.buildPieParts(cx, 50, volume, isMuted, '#CCCCCC'),
            ...this.buildTextParts(cx, volume, isMuted, groupName, align, showText),
            '</svg>',
        );

        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svgParts.join('')).toString('base64')}`,
        }).catch(() => {});
    }
}
