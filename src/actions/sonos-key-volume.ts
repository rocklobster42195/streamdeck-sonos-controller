import { type JsonValue } from "@elgato/utils";
import streamDeck, { 
    action, 
    KeyDownEvent, 
    KeyUpEvent,
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
import { generateFaderSvg } from "../sonos/utils";
import { generateVolumeButtonIcon } from "../utils/icons";

type SonosKeyVolumeSettings = {
    deviceIp?: string;
    command?: 'mute' | 'vol-up' | 'vol-down' | 'vol-preset';
    volume?: number;
    presetVolume?: number;
    showVolume?: boolean;
    showPreset?: boolean;
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-key-volume" })
export class SonosKeyVolume extends SingletonAction<SonosKeyVolumeSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private initializedHash: Map<string, string> = new Map();
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private longPressExecuted: Map<string, boolean> = new Map();

    private async updateIcon(action: any, volume: number, isMuted: boolean, command?: 'mute' | 'vol-up' | 'vol-down' | 'vol-preset') {
        if (!action) return;

        let iconFile = '';
        const basePath = 'imgs/actions/sonos-key-volume/';

        switch (command) {
            case 'mute':
                iconFile = generateFaderSvg(volume, isMuted, "#CCCCCC");
                break;
            case 'vol-up':
                iconFile = generateVolumeButtonIcon('up');
                break;
            case 'vol-down':
                iconFile = generateVolumeButtonIcon('down');
                break;
            case 'vol-preset':
                iconFile = generateVolumeButtonIcon('preset');
                break;
            default:
                iconFile = `${basePath}volume-high-cccccc.png`;
                break;
        }
        
        await action.setImage(iconFile);
    }

    private async updateTitle(action: any, settings: SonosKeyVolumeSettings, volume: { volume: number, mute: boolean }) {
        const { command, showVolume, showPreset, presetVolume, volume: legacyVolume } = settings;
        const preset = presetVolume ?? legacyVolume;

        if (showPreset && typeof preset === 'number') {
            await action.setTitle(`${preset}`);
            return;
        }

        let shouldShowVolume = false;
        if (showVolume) {
            if (command === 'vol-up' || command === 'vol-down') {
                shouldShowVolume = true;
            } else if (command === 'mute' && !volume.mute) {
                shouldShowVolume = true;
            }
        }

        if (shouldShowVolume) {
            await action.setTitle(`${volume.volume}`);
        } else {
            await action.setTitle("");
        }
    }

    private async onInstanceUpdate(ev: WillAppearEvent<SonosKeyVolumeSettings> | DidReceiveSettingsEvent<SonosKeyVolumeSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const { deviceIp, command, showVolume, showPreset, volume, presetVolume } = payload.settings;
        const settings = payload.settings;

        const preset = presetVolume ?? volume;
        const currentHash = `${deviceIp}-${command}-${preset}-${showVolume}-${showPreset}`;
        if (this.initializedHash.get(context) === currentHash) {
            return;
        }

        await discoveryPromise;

        if (!deviceIp || !command) {
            await action.setTitle("Config...");
            return;
        }

        try {
            const oldController = this.controllers.get(context);
            if (oldController && oldController.deviceIp !== deviceIp) {
                oldController.unregisterVolumeCallback(context);
                sonosDeviceManager.releaseController(oldController.deviceIp);
            }

            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);
            
            // Register callback for live mute/volume updates
            controller.unregisterVolumeCallback(context);
            controller.registerVolumeCallback(context, (volume) => {
                this.updateIcon(action, volume.volume, volume.mute, command);
                this.updateTitle(action, settings, volume);
            });

            // Set initial icon
            const currentVolume = await controller.getVolume();
            await this.updateIcon(action, currentVolume.volume, currentVolume.mute, command);
            await this.updateTitle(action, settings, currentVolume);
            
            this.initializedHash.set(context, currentHash);
            streamDeck.logger.info(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Setup error:`, e);
            await action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosKeyVolumeSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }
    
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosKeyVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        
        // Immediately unregister the callback to prevent race conditions with stale settings.
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
        }

        this.initializedHash.delete(context);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosKeyVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
        this.initializedHash.delete(context);

        const timer = this.timers.get(context);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(context);
        }
        this.longPressExecuted.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosKeyVolumeSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.controllers.get(action.id);
        const { command, volume, presetVolume } = payload.settings;
        const preset = presetVolume ?? volume;

        if (!controller || !command) {
            action.showAlert();
            return;
        }

        // vol-preset is a single-action command, execute immediately.
        if (command === 'vol-preset') {
            try {
                if (typeof preset === 'number') {
                    await controller.setVolume(preset); 
                } else {
                    action.showAlert();
                }
            } catch (e) {
                action.showAlert();
            }
            return;
        }

        // For other commands, set up a timer for long-press detection.
        if (typeof preset === 'number') {
            const timer = setTimeout(async () => {
                try {
                    await controller.setVolume(preset);
                    this.longPressExecuted.set(action.id, true);
                } catch (e) {
                    action.showAlert();
                }
            }, 500); // 500ms for long press
            this.timers.set(action.id, timer);
        }
    }

    override async onKeyUp(ev: KeyUpEvent<SonosKeyVolumeSettings>): Promise<void> {
        const { action, payload } = ev;
        const { command } = payload.settings;
        const controller = this.controllers.get(action.id);

        const timer = this.timers.get(action.id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(action.id);
        }

        if (!controller) {
            action.showAlert();
            return;
        }

        // If long press was executed, do nothing further on keyUp.
        if (this.longPressExecuted.get(action.id)) {
            this.longPressExecuted.delete(action.id);
            return;
        }

        // Otherwise, it was a short press. Execute the default action.
        try {
            switch (command) {
                case 'mute': await controller.toggleMute(); break;
                case 'vol-up': await controller.volumeUp(2); break;
                case 'vol-down': await controller.volumeDown(2); break;
            }
        } catch (e) {
            action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosKeyVolumeSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;

                const deviceItems = sonosManager.Devices.map((device: SonosDevice) => ({
                    label: device.Name,
                    value: device.Host
                }));

                const itemsWithPlaceholder = [
                    { label: "-- Choose device --", value: "" },
                    ...deviceItems
                ];

                await streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: itemsWithPlaceholder
                });
            }
        }
    }
}