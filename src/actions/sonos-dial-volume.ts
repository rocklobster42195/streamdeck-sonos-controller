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
import { particleEngine } from "../utils/ParticleEngine";
import { panoramaContextGroupKey, registerInPanorama, unregisterFromPanorama, getPanoramaSliceOffset } from "./sonos-dial-particles";
import { mdiVolumeOff } from "@mdi/js";

type SonosDialVolumeSettings = {
    deviceIp?: string;
    presetVolume?: number;
    align?: 'left' | 'center' | 'right';
    visualizerMode?: 'none' | 'particles';
    particleCount?: number;
    particleSpeed?: number;
};

interface DialState {
    volume?: number;
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

    private onVolumeInfoChanged(context: string, volumeInfo: VolumeInfo): void {
        const state = this.states.get(context);
        if (state) {
            state.volume = volumeInfo.volume;
            state.isMuted = volumeInfo.mute;
            void this.renderDial(context);
        }
    }

    private startAnimTimer(context: string): void {
        if (this.animTimers.has(context)) return;
        const timer = setInterval(() => {
            const settings = this.settingsMap.get(context);
            if (settings?.visualizerMode !== 'particles') { this.stopAnimTimer(context); return; }
            const inPanorama = !!panoramaContextGroupKey.get(context);
            if (!inPanorama) particleEngine.tick(context);
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
        const oldController = this.controllers.get(context);
        if (oldController) {
            oldController.unregisterVolumeCallback(context);
            sonosDeviceManager.releaseController(oldController.deviceIp);
            this.controllers.delete(context);
        }
        this.states.delete(context);
        this.settingsMap.delete(context);
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
            controller.registerVolumeCallback(context, (vi: VolumeInfo) => this.onVolumeInfoChanged(context, vi));

            const [zone, vol] = await Promise.all([controller.getZoneAttributes(), controller.getVolume()]);
            const state = this.states.get(context);
            if (state) {
                state.deviceName = zone.CurrentZoneName;
                state.volume = vol.volume;
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
        const controller = this.controllers.get(ev.action.id);
        if (controller) await controller.toggleMute();
    }

    override async onTouchTap(ev: TouchTapEvent<SonosDialVolumeSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) await controller.setVolume(ev.payload.settings.presetVolume ?? 50);
    }

    override async onDialRotate(ev: DialRotateEvent<SonosDialVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state || state.volume === undefined) return;

        if (state.isMuted) await controller.toggleMute();

        const ticks = ev.payload.ticks;
        const newVolume = Math.min(100, Math.max(0, state.volume + ticks * (Math.abs(ticks) > 3 ? 2 : 1)));
        if (newVolume !== state.volume) {
            state.volume = newVolume;
            void this.renderDial(context);
            await controller.setVolume(newVolume);
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
            if (ev.payload.event === 'get-particle-state') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'particle-state',
                    inPanorama: !!panoramaContextGroupKey.get(ev.action.id),
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

    private buildTextParts(cx: number, volume: number, isMuted: boolean, deviceName: string, align: string): string[] {
        const volumeText = isMuted ? 'MUTE' : `${volume}%`;
        const name = deviceName.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
        const color = '#CCCCCC';
        const dim = '#999999';

        if (align === 'center') {
            return [];
        }

        const textX = align === 'right' ? 55 : 145;
        const parts: string[] = [
            `<text x="${textX}" y="46" fill="${color}" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${volumeText}</text>`,
        ];
        if (name) parts.push(`<text x="${textX}" y="64" fill="${dim}" font-family="Arial,sans-serif" font-size="11" text-anchor="middle">${name}</text>`);
        return parts;
    }

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction?.isDial()) return;

        const settings = this.settingsMap.get(context);
        const state = this.states.get(context);
        const align = settings?.align ?? 'left';
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
                'icon': '', 'title': '', 'indicator': { value: 0, enabled: false },
            }).catch(() => {});
            return;
        }

        const volume = state?.volume ?? 0;
        const isMuted = state?.isMuted ?? false;
        const deviceName = state?.deviceName ?? '';
        const cx = align === 'center' ? 100 : align === 'right' ? 150 : 50;
        const cy = 50;

        const pieParts = this.buildPieParts(cx, cy, volume, isMuted, '#CCCCCC');
        const textParts = this.buildTextParts(cx, volume, isMuted, deviceName, align);

        const panoramaKey = visualizerMode === 'particles' ? panoramaContextGroupKey.get(context) : undefined;
        const standaloneParticles = visualizerMode === 'particles' && !panoramaKey;

        let particleFrag = '';
        if (panoramaKey) {
            particleFrag = particleEngine.renderPanoramaSlice(panoramaKey, getPanoramaSliceOffset(context));
        } else if (standaloneParticles) {
            particleFrag = particleEngine.render(context, 0, 0);
        }

        const hasParticles = !!(panoramaKey || standaloneParticles);
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
            'icon': '', 'title': '', 'indicator': { value: 0, enabled: false },
        }).catch(() => {});
    }
}
