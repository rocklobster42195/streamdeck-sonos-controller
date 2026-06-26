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
  WillDisappearEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { getIconByVolume } from "../sonos/utils";
import { generateVolumeLevelIcon } from "../utils/icons";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { VolumeInfo } from "../sonos/SonosTypes";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";

/**
 * Settings for {@link SonosDialVolume}.
 */
type SonosSettings = {
    deviceIp?: string;
    presetVolume?: number;
};

interface DialState {
    volume?: number;
    isMuted?: boolean;
    deviceName?: string;
}

/**
 * An action that interacts with a Sonos speaker to control volume using a dial.
 */
@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-volume" })
export class SonosDialVolume extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, DialState> = new Map();

    private onVolumeInfoChanged(context: string, volumeInfo: VolumeInfo): void {
        const state = this.states.get(context);
        if (state) {
            state.volume = volumeInfo.volume;
            state.isMuted = volumeInfo.mute;
            this.updateFeedback(context);
        }
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const { deviceIp } = ev.payload.settings;

        // Cleanup old controller and callbacks
        const oldController = this.controllers.get(context);
        if (oldController) {
            oldController.unregisterVolumeCallback(context);
            this.controllers.delete(context);
        }
        
        this.states.set(context, {});

        if (!deviceIp) {
            await ev.action.setTitle("Config...");
            return;
        }

        try {
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            // Register a single callback for combined volume and mute info
            controller.registerVolumeCallback(context, (volumeInfo) => {
                this.onVolumeInfoChanged(context, volumeInfo);
            });

            // Get initial state
            const zoneAttributes = await controller.getZoneAttributes();
            const state = this.states.get(context)!;
            state.deviceName = zoneAttributes.CurrentZoneName;

            const volumeInfo = await controller.getVolume();
            state.volume = volumeInfo.volume;
            state.isMuted = volumeInfo.mute;

            this.updateFeedback(context);
        } catch (e) {
            streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
            await ev.action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
            this.states.delete(context);
        }
    }

    override async onDialDown(ev: DialDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            await controller.toggleMute();
        }
    }

    override async onTouchTap(ev: TouchTapEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            const { settings } = ev.payload;
            await controller.setVolume(settings.presetVolume ?? 50);
        }
    }

    override async onDialRotate(ev: DialRotateEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state || state.volume === undefined) {
            return;
        }
        
        // Unmute if volume is changed while muted
        if (state.isMuted) {
            await controller.toggleMute();
        }

        const ticks = ev.payload.ticks;
        const currentVolume = state.volume;
        const volumeChange = ticks * (Math.abs(ticks) > 3 ? 2 : 1);
        const newVolume = Math.min(100, Math.max(0, currentVolume + volumeChange));

        if (newVolume !== currentVolume) {
            // Update state immediately so rapid rotation accumulates correctly
            // and the indicator responds without waiting for the UPnP event.
            state.volume = newVolume;
            this.updateFeedback(context);
            await controller.setVolume(newVolume);
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
        }
    }

    private async updateFeedback(context: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        const state = this.states.get(context);
        if (action && action.isDial() && state) {
            const volume = state.volume ?? 0;
            action.setFeedback({
                title: `${state.deviceName ?? "Volume"}`,
                value: state.isMuted ? 'Muted' : `${volume}%`,
                icon: generateVolumeLevelIcon(volume, state.isMuted ?? false),
               indicator: { value: volume },
            });
        }
    }
}
