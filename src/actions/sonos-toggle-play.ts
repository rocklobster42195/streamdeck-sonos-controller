import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { titleAnimator } from "../utils/TitleAnimator";
import { TrackInfo } from "../sonos/SonosTypes";
import { generateTransportIcon } from "../utils/icons";

/**
 * Settings for {@link SonosTogglePlay}.
 */
type SonosSettings = {
    deviceIp?: string;
    showDeviceName?: boolean;
    showCoverArt?: boolean;
    showTrackTitle?: boolean;
    showBattery?: boolean;
    fontColor?: string;
    fontSize?: number;
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-toggle-play" })
export class SonosTogglePlay extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private currentSettings: Map<string, SonosSettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();
    private batteryListeners: Map<string, (evt: any) => void> = new Map();
    private batteryLevels: Map<string, number | null> = new Map();
    private hasBattery: Map<string, boolean> = new Map();

    private parseBattPct(info: string): number | null {
        const m = info.match(/BattPct=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    private batteryDotUri(baseUri: string, battPct: number): string {
        const color = battPct > 40 ? '#44CC44' : battPct > 20 ? '#FFCC00' : '#FF4444';
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 72 72">`
            + `<image href="${baseUri}" width="72" height="72"/>`
            + `<circle cx="63" cy="9" r="5" fill="${color}"/>`
            + `</svg>`;
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }

    private withBattery(uri: string, context: string): string {
        const level = this.batteryLevels.get(context);
        if (level == null) return uri;
        const settings = this.currentSettings.get(context);
        // Always show red dot on low battery; full indicator only when enabled in PI.
        if (!settings?.showBattery && level >= 20) return uri;
        return this.batteryDotUri(uri, level);
    }

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const newCover = trackInfo.albumArtDataUri || undefined;
        const oldCover = this.currentCover.get(context) || undefined;

        // Skip when the same real cover is already showing.
        if (newCover && newCover === oldCover) return;
        // Skip when no new art arrives but a cached cover is already visible.
        if (!newCover && oldCover) return;

        if (newCover) this.currentCover.set(context, newCover);
        const controller = this.controllers.get(context);
        if (controller) {
            controller.getTransportState().then(state => {
                this.handleTransportStateChange(context, state, newCover);
            });
        }
    }

    private async handleTransportStateChange(context: string, transportState: string, newCover?: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        if (!action) return;

        const settings = this.currentSettings.get(context);
        const controller = this.controllers.get(context);
        if (!controller || !settings) return;

        if (transportState === "PLAYING") {
            let cover = newCover || this.currentCover.get(context) || undefined;
            if (!cover) {
                // Cover cache empty — happens when the plugin starts/restarts during a radio news
                // segment with no art. Try once to fetch from the controller (which derives the
                // station logo from the stream URI, stable even during news).
                try { cover = await controller.getCurrentTrackCover() || undefined; } catch {}
            }
            if (cover) this.currentCover.set(context, cover);
            
            streamDeck.logger.debug(`[${context}] showTrackTitle: ${settings.showTrackTitle}, showCoverArt: ${settings.showCoverArt}, cover available: ${cover ? "yes" : "no"}`);

            if (settings.showTrackTitle) {
                const track = await controller.getCurrentTrack();
                const title = track?.Title
                    ? `${track.Title}${track.Artist ? ` [${track.Artist}]` : ""}`
                    : "";

                const animOptions = {
                    text: title,
                    backgroundImage: (settings.showCoverArt && cover) ? cover : undefined,
                    fontColor: settings.fontColor || "#cccccc",
                    fontSize: settings.fontSize ? settings.fontSize : 13,
                    pauseDuration: 120,
                    interval: 80
                };

                if (titleAnimator.isRunning(context)) {
                    titleAnimator.update(context, { text: title, backgroundImage: animOptions.backgroundImage });
                } else {
                    titleAnimator.start(action, animOptions);
                }
            } else {
                titleAnimator.stop(context);
                if (settings.showCoverArt && cover) {
                    await action.setImage(this.withBattery(cover, context));
                } else {
                    await action.setImage(this.withBattery(generateTransportIcon('play'), context));
                }
            }
        } else {
            titleAnimator.stop(context);

            switch (transportState) {
                case "TRANSITIONING":
                    await action.setImage(this.withBattery(generateTransportIcon('loading'), context));
                    break;
                default: // PAUSED, STOPPED
                    await action.setImage(this.withBattery(generateTransportIcon('play'), context));
                    break;
            }
        }
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const action = ev.action;
        const settings = ev.payload.settings;

        if (this.controllers.has(context)) {
            const oldController = this.controllers.get(context)!;
            oldController.unregisterTransportStateCallback(context);
            oldController.unregisterTrackInfoCallback(context);
            const oldBattListener = this.batteryListeners.get(context);
            if (oldBattListener) {
                oldController.sonosDevice.DevicePropertiesService.Events.removeListener('serviceEvent', oldBattListener);
                this.batteryListeners.delete(context);
            }
            this.controllers.delete(context);
        }
        this.currentCover.delete(context);
        this.batteryLevels.delete(context);
        this.hasBattery.delete(context);

        if (!settings.deviceIp) {
            titleAnimator.stop(context);
            await action.setTitle("");
            action.showAlert();
            return;
        }

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            // Transport state changes (play/pause/stop)
            controller.registerTransportStateCallback(context, (state) => {
                this.handleTransportStateChange(context, state);
            });

            // Track info changes — this is the only cover update path
            controller.registerTrackInfoCallback(context, (trackInfo) => {
                this.onTrackInfoChanged(context, trackInfo);
            });

            // Always probe for battery capability so the PI can show/hide the checkbox.
            let hasBatt = false;
            try {
                const info = await controller.sonosDevice.DevicePropertiesService.GetZoneInfo();
                const initPct = this.parseBattPct(info.ExtraInfo ?? '');
                hasBatt = initPct !== null;
                this.hasBattery.set(context, hasBatt);
                if (hasBatt) {
                    this.batteryLevels.set(context, initPct!);
                    const battListener = (evt: any) => {
                        const pct = this.parseBattPct(evt.MoreInfo ?? '');
                        if (pct !== null) {
                            this.batteryLevels.set(context, pct);
                            const ctrl = this.controllers.get(context);
                            if (ctrl) ctrl.getTransportState().then(s => this.handleTransportStateChange(context, s));
                        }
                    };
                    this.batteryListeners.set(context, battListener);
                    controller.sonosDevice.DevicePropertiesService.Events.on('serviceEvent', battListener);
                }
            } catch (e) {
                streamDeck.logger.debug('DevicePropertiesService probe failed', e);
            }
            streamDeck.ui.sendToPropertyInspector({ event: 'device-info', hasBattery: hasBatt });

            if (settings.showDeviceName) {
                const zoneAttributes = await controller.getZoneAttributes();
                await action.setTitle(zoneAttributes.CurrentZoneName);
            } else {
                await action.setTitle("");
            }

            const state = await controller.getTransportState();
            
            // Prime the cover cache before first render.
            // For radio stations this often returns undefined — trackInfoCallback fills it later.
            if (state === "PLAYING" && !this.currentCover.has(context)) {
                const initialCover = await controller.getCurrentTrackCover();
                if (initialCover) this.currentCover.set(context, initialCover);
            }
            
            await this.handleTransportStateChange(context, state);

        } catch (e) {
            streamDeck.logger.error(`Error updating instance ${context}`, e);
            await action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        this.currentSettings.set(ev.action.id, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        this.currentSettings.set(context, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        titleAnimator.stop(context);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            const battListener = this.batteryListeners.get(context);
            if (battListener) {
                controller.sonosDevice.DevicePropertiesService.Events.removeListener('serviceEvent', battListener);
            }
            if (ev.payload.settings.deviceIp) {
                sonosDeviceManager.releaseController(ev.payload.settings.deviceIp);
            }
        }
        this.controllers.delete(context);
        this.currentSettings.delete(context);
        this.currentCover.delete(context);
        this.batteryListeners.delete(context);
        this.batteryLevels.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            await controller.togglePlayPause();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-devices': {
                await discoveryPromise;
                const items = sonosManager.Devices.map((device: SonosDevice) => ({
                    label: device.Name,
                    value: device.Host
                }));
                streamDeck.ui.sendToPropertyInspector({ event: 'get-devices', items });
                break;
            }
            case 'get-device-info': {
                const hasBatt = this.hasBattery.get(ev.action.id) ?? false;
                streamDeck.ui.sendToPropertyInspector({ event: 'device-info', hasBattery: hasBatt });
                break;
            }
        }
    }
}