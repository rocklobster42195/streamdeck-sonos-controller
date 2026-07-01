import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    KeyDownEvent,
    KeyUpEvent,
    SingletonAction,
    WillAppearEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { generateFaderSvg } from "../sonos/utils";
import { generateVolumeButtonIcon } from "../utils/icons";
import { piT } from "../utils/pi-i18n";

type Settings = {
    deviceIp?: string;
    command?: 'group-mute' | 'group-vol-up' | 'group-vol-down' | 'group-vol-preset';
    presetVolume?: number;
    showPreset?: boolean;
    showVolume?: boolean;
};

interface KeyState {
    volume: number;
    isMuted: boolean;
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-key-group-volume" })
export class SonosKeyGroupVolume extends SingletonAction<Settings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private listeners: Map<string, (evt: any) => void> = new Map();
    private keyStates: Map<string, KeyState> = new Map();
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private longPressExecuted: Map<string, boolean> = new Map();

    private async updateDisplay(action: any, settings: Settings, state: KeyState): Promise<void> {
        const { command, showVolume, showPreset, presetVolume } = settings;
        const { volume, isMuted } = state;

        let icon = '';
        switch (command) {
            case 'group-mute':    icon = generateFaderSvg(volume, isMuted, '#CCCCCC'); break;
            case 'group-vol-up':  icon = generateVolumeButtonIcon('up'); break;
            case 'group-vol-down': icon = generateVolumeButtonIcon('down'); break;
            case 'group-vol-preset': icon = generateVolumeButtonIcon('preset'); break;
            default: icon = 'imgs/actions/sonos-key-volume/icon';
        }
        await action.setImage(icon);

        if (showPreset && typeof presetVolume === 'number') {
            await action.setTitle(`${presetVolume}`);
            return;
        }
        const relevant = command === 'group-vol-up' || command === 'group-vol-down'
            || (command === 'group-mute' && !isMuted);
        await action.setTitle(showVolume && relevant ? `${volume}` : '');
    }

    private cleanupInstance(context: string): void {
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
        const timer = this.timers.get(context);
        if (timer) { clearTimeout(timer); this.timers.delete(context); }
        this.keyStates.delete(context);
        this.longPressExecuted.delete(context);
    }

    private async onInstanceUpdate(ev: WillAppearEvent<Settings> | DidReceiveSettingsEvent<Settings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const settings = payload.settings;

        this.cleanupInstance(context);

        if (!settings.deviceIp || !settings.command) {
            await action.setTitle('Config...');
            return;
        }

        await discoveryPromise;

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            const state: KeyState = { volume: 0, isMuted: false };
            this.keyStates.set(context, state);

            const listener = (evt: any) => {
                if (evt.GroupVolume !== undefined) state.volume = evt.GroupVolume;
                if (evt.GroupMute !== undefined) state.isMuted = !!evt.GroupMute;
                void this.updateDisplay(action, settings, state);
            };
            this.listeners.set(context, listener);
            controller.sonosDevice.GroupRenderingControlService.Events.on('serviceEvent', listener);

            const [groupVol, groupMute] = await Promise.all([
                controller.sonosDevice.GroupRenderingControlService.GetGroupVolume({ InstanceID: 0 }),
                controller.sonosDevice.GroupRenderingControlService.GetGroupMute({ InstanceID: 0 }),
            ]);
            state.volume = groupVol.CurrentVolume;
            state.isMuted = !!groupMute.CurrentMute;
            await this.updateDisplay(action, settings, state);
        } catch (e) {
            streamDeck.logger.error(`SonosKeyGroupVolume: error for ${settings.deviceIp}`, e);
            await action.setTitle('Error');
        }
    }

    override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
    }

    override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const controller = this.controllers.get(context);
        const { command, presetVolume } = payload.settings;

        if (!controller || !command) { action.showAlert(); return; }

        if (command === 'group-vol-preset') {
            try {
                if (typeof presetVolume === 'number') {
                    await controller.sonosDevice.GroupRenderingControlService.SetGroupVolume({ InstanceID: 0, DesiredVolume: presetVolume });
                } else { action.showAlert(); }
            } catch { action.showAlert(); }
            return;
        }

        if (typeof presetVolume === 'number') {
            const timer = setTimeout(async () => {
                try {
                    await controller.sonosDevice.GroupRenderingControlService.SetGroupVolume({ InstanceID: 0, DesiredVolume: presetVolume });
                    this.longPressExecuted.set(context, true);
                } catch { action.showAlert(); }
            }, 500);
            this.timers.set(context, timer);
        }
    }

    override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const { command } = payload.settings;
        const controller = this.controllers.get(context);

        const timer = this.timers.get(context);
        if (timer) { clearTimeout(timer); this.timers.delete(context); }

        if (!controller) { action.showAlert(); return; }
        if (this.longPressExecuted.get(context)) { this.longPressExecuted.delete(context); return; }

        try {
            switch (command) {
                case 'group-mute': {
                    const state = this.keyStates.get(context);
                    await controller.sonosDevice.GroupRenderingControlService.SetGroupMute({ InstanceID: 0, DesiredMute: !state?.isMuted });
                    break;
                }
                case 'group-vol-up':
                    await controller.sonosDevice.GroupRenderingControlService.SetRelativeGroupVolume({ InstanceID: 0, Adjustment: 2 });
                    break;
                case 'group-vol-down':
                    await controller.sonosDevice.GroupRenderingControlService.SetRelativeGroupVolume({ InstanceID: 0, Adjustment: -2 });
                    break;
            }
        } catch { action.showAlert(); }
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
        if (ev.payload.event === 'get-command-options') {
            streamDeck.ui.sendToPropertyInspector({
                event: 'get-command-options',
                items: [
                    { label: piT('-- Select Command --'), value: '' },
                    { label: piT('Mute / Preset'), value: 'group-mute' },
                    { label: piT('Volume Up'), value: 'group-vol-up' },
                    { label: piT('Volume Down'), value: 'group-vol-down' },
                    { label: piT('Volume Preset'), value: 'group-vol-preset' },
                ],
            });
        }
    }
}
