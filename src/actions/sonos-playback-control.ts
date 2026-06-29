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
import { TrackInfo } from "../sonos/SonosTypes";
import { generatePlaybackIcon } from "../utils/icons";
import { piT } from "../utils/pi-i18n";

type SonosPlaybackSettings = {
    deviceIp?: string;
    command?: 'next' | 'previous' | 'shuffle' | 'repeat';
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-playback-control" })
export class SonosPlaybackControl extends SingletonAction<SonosPlaybackSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private initializedHash: Map<string, string> = new Map();
    private isRadioByContext: Map<string, boolean> = new Map();
    private playModeByContext: Map<string, string> = new Map();

    private updateIcon(action: any, command: SonosPlaybackSettings['command'], playMode = '', isRadio = false): void {
        if (!action || !command) return;

        const skipColor = isRadio ? '#252525' : '#CCCCCC';
        const set = (img: string) => action.setImage(img).catch(() => {});

        switch (command) {
            case 'next':
                set(generatePlaybackIcon('next', false, skipColor));
                break;
            case 'previous':
                set(generatePlaybackIcon('previous', false, skipColor));
                break;
            case 'shuffle':
                set(generatePlaybackIcon('shuffle',
                    isRadio ? false : playMode.includes('SHUFFLE'),
                    '#CCCCCC',
                    isRadio ? '#252525' : '#555555'
                ));
                break;
            case 'repeat':
                if (isRadio) {
                    set(generatePlaybackIcon('repeat', false, '#CCCCCC', '#252525'));
                } else if (playMode.includes('REPEAT_ONE')) {
                    // REPEAT_ONE or SHUFFLE_REPEAT_ONE
                    set(generatePlaybackIcon('repeat', 'one'));
                } else if (playMode === 'REPEAT_ALL' || playMode === 'SHUFFLE' || playMode === 'SHUFFLE_REPEAT_ALL') {
                    // SHUFFLE in the Sonos API means shuffle + repeat-all (confusingly named).
                    set(generatePlaybackIcon('repeat', 'all'));
                } else {
                    // NORMAL or SHUFFLE_NOREPEAT
                    set(generatePlaybackIcon('repeat', false));
                }
                break;
        }
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
                oldController.unregisterTrackInfoCallback(context);
                sonosDeviceManager.releaseController(oldController.deviceIp);
            }

            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            controller.unregisterPlayModeCallback(context);
            controller.registerPlayModeCallback(context, (playMode) => {
                this.playModeByContext.set(context, playMode);
                this.updateIcon(action, command, playMode, this.isRadioByContext.get(context) ?? false);
            });

            controller.unregisterTrackInfoCallback(context);
            controller.registerTrackInfoCallback(context, (trackInfo: TrackInfo) => {
                const isRadio = trackInfo.isRadio ?? false;
                const wasRadio = this.isRadioByContext.get(context);
                this.isRadioByContext.set(context, isRadio);
                // Re-render whenever radio status changes — affects all command types.
                if (isRadio !== wasRadio || command === 'next' || command === 'previous') {
                    this.updateIcon(action, command, this.playModeByContext.get(context) ?? '', isRadio);
                }
            });

            const [currentMode] = await Promise.all([controller.getPlayMode()]);
            this.playModeByContext.set(context, currentMode);
            this.updateIcon(action, command, currentMode, this.isRadioByContext.get(context) ?? false);
            await action.setTitle("");

            this.initializedHash.set(context, currentHash);
            streamDeck.logger.debug(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

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
            controller.unregisterTrackInfoCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
        this.initializedHash.delete(context);
        this.isRadioByContext.delete(context);
        this.playModeByContext.delete(context);
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
                case 'next':     await controller.next(); break;
                case 'previous': await controller.previous(); break;
                case 'shuffle':  await controller.toggleShuffle(); break;
                case 'repeat':   await controller.toggleRepeat(); break;
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
            if (ev.payload.event === 'get-command-options') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-command-options',
                    items: [
                        { label: piT('-- Select Command --'), value: '' },
                        { label: piT('Next Track'), value: 'next' },
                        { label: piT('Previous Track'), value: 'previous' },
                        { label: piT('Toggle Shuffle'), value: 'shuffle' },
                        { label: piT('Toggle Repeat'), value: 'repeat' },
                    ],
                });
            }
        }
    }
}
