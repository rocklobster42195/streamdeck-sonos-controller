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

type SonosPlaybackSettings = {
    deviceIp?: string;
    command?: 'next' | 'previous' | 'shuffle' | 'repeat';
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-playback-control" })
export class SonosPlaybackControl extends SingletonAction<SonosPlaybackSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private initializedHash: Map<string, string> = new Map();

    private updateIcon(action: any, command: SonosPlaybackSettings['command'], playMode: string = "") {
        if (!action || !command) return;

        let icon = "";
        const baseIconPath = "imgs/actions/sonos-playback-control/";

        switch (command) {
            case 'next':
                icon = `${baseIconPath}skip-next-cccccc.png`;
                break;
            case 'previous':
                icon = `${baseIconPath}skip-previous-cccccc.png`;
                break;
            case 'shuffle':
                icon = playMode.includes('SHUFFLE')
                    ? `${baseIconPath}shuffle-cccccc.png`
                    : `${baseIconPath}shuffle-off-cccccc.png`;
                break;
            case 'repeat':
                if (playMode.includes('REPEAT_ONE')) {
                    icon = `${baseIconPath}repeat-once-cccccc.png`;
                } else if (playMode.includes('REPEAT_ALL')) {
                    icon = `${baseIconPath}repeat-cccccc.png`;
                } else {
                    icon = `${baseIconPath}repeat-off-cccccc.png`;
                }
                break;
            default:
                return;
        }

        if (icon) action.setImage(icon);
    }

    private async onInstanceUpdate(ev: WillAppearEvent<SonosPlaybackSettings> | DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const { deviceIp, command } = payload.settings;

        const currentHash = `${deviceIp}-${command}`;
        if (this.initializedHash.get(context) === currentHash) return;

        await discoveryPromise;

        if (!deviceIp || !command) {
            await action.setTitle("Config...");
            return;
        }

        try {
            const oldController = this.controllers.get(context);
            if (oldController && oldController.deviceIp !== deviceIp) {
                oldController.unregisterPlayModeCallback(context);
                sonosDeviceManager.releaseController(oldController.deviceIp);
            }

            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            controller.unregisterPlayModeCallback(context);
            controller.registerPlayModeCallback(context, (playMode) => {
                this.updateIcon(action, command, playMode);
            });

            const currentMode = await controller.getPlayMode();
            this.updateIcon(action, command, currentMode);
            await action.setTitle("");

            this.initializedHash.set(context, currentHash);
            streamDeck.logger.info(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Setup error:`, e);
            await action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosPlaybackSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        this.initializedHash.delete(ev.action.id);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterPlayModeCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
        this.initializedHash.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosPlaybackSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        const { command } = ev.payload.settings;

        if (!controller || !command) {
            ev.action.showAlert();
            return;
        }

        try {
            switch (command) {
                case 'next': await controller.next(); break;
                case 'previous': await controller.previous(); break;
                case 'shuffle': await controller.toggleShuffle(); break;
                case 'repeat': await controller.toggleRepeat(); break;
            }
        } catch (e) {
            ev.action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosPlaybackSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;

                const deviceItems = sonosManager.Devices.map((device: SonosDevice) => ({
                    label: device.Name,
                    value: device.Host
                }));

                await streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: "-- Choose device --", value: "" }, ...deviceItems]
                });
            }
        }
    }
}
