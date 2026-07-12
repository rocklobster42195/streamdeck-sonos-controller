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
import { generateVolumeButtonIcon, generateUnreachableKeyIcon } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";

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
    private actionRefs: Map<string, any> = new Map();
    private volumeAnimState: Map<string, { volume: number; displayVolume: number; isMuted: boolean; command?: 'mute' | 'vol-up' | 'vol-down' | 'vol-preset' }> = new Map();
    private volumeAnimTimers: Map<string, NodeJS.Timeout> = new Map();

    // Eases the fader icon toward the actual volume instead of snapping to it,
    // matching the SonosDialVolume behavior. Only relevant for the 'mute' command,
    // whose icon is the only one that visualizes the volume level.
    private startVolumeAnim(context: string): void {
        if (this.volumeAnimTimers.has(context)) return;
        const timer = setInterval(() => {
            const state = this.volumeAnimState.get(context);
            const action = this.actionRefs.get(context);
            if (!state || !action) { this.stopVolumeAnim(context); return; }
            const diff = state.volume - state.displayVolume;
            if (Math.abs(diff) < 0.3) {
                state.displayVolume = state.volume;
                this.stopVolumeAnim(context);
            } else {
                state.displayVolume += diff * 0.4;
            }
            void this.updateIcon(action, state.displayVolume, state.isMuted, state.command);
        }, 25);
        this.volumeAnimTimers.set(context, timer);
    }

    private stopVolumeAnim(context: string): void {
        const timer = this.volumeAnimTimers.get(context);
        if (timer) { clearInterval(timer); this.volumeAnimTimers.delete(context); }
    }

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

    private setupRetry = new SetupRetryScheduler();

    private async onInstanceUpdate(ev: WillAppearEvent<SonosKeyVolumeSettings> | DidReceiveSettingsEvent<SonosKeyVolumeSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        this.setupRetry.cancel(context);
        const { deviceIp, command, showVolume, showPreset, volume, presetVolume } = payload.settings;
        const settings = payload.settings;

        this.actionRefs.set(context, action);

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
            // Always release the previous reference before reacquiring — even when deviceIp is
            // unchanged. getController() unconditionally increments its refCount, so acquiring
            // without a matching prior release (as this used to do whenever only some other
            // setting changed) leaked one refCount per settings change: the underlying
            // SonosDeviceController's polling/event timers then never got torn down even after
            // this key was removed, since onWillDisappear only releases once.
            const oldController = this.controllers.get(context);
            if (oldController) {
                oldController.unregisterVolumeCallback(context);
                oldController.unregisterReachabilityCallback(context);
                sonosDeviceManager.releaseController(oldController.deviceIp);
            }

            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);

            controller.registerReachabilityCallback(context, (reachable) => {
                if (reachable) {
                    void this.onInstanceUpdate(ev);
                } else {
                    void action.setImage(generateUnreachableKeyIcon());
                    void action.setTitle("");
                }
            });

            // Register callback for live mute/volume updates
            controller.unregisterVolumeCallback(context);
            controller.registerVolumeCallback(context, (volume) => {
                const state = this.volumeAnimState.get(context);
                if (state) {
                    state.volume = volume.volume;
                    state.isMuted = volume.mute;
                    state.command = command;
                } else {
                    this.volumeAnimState.set(context, {
                        volume: volume.volume, displayVolume: volume.volume, isMuted: volume.mute, command,
                    });
                }
                if (command === 'mute') this.startVolumeAnim(context);
                else this.updateIcon(action, volume.volume, volume.mute, command);
                this.updateTitle(action, settings, volume);
            });

            // Set initial icon (snap, no animation on first render)
            const currentVolume = await controller.getVolume();
            this.volumeAnimState.set(context, {
                volume: currentVolume.volume, displayVolume: currentVolume.volume, isMuted: currentVolume.mute, command,
            });
            await this.updateIcon(action, currentVolume.volume, currentVolume.mute, command);
            await this.updateTitle(action, settings, currentVolume);
            
            this.initializedHash.set(context, currentHash);
            streamDeck.logger.debug(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Setup error:`, e);
            // Configured but unreachable — dark speaker-off glyph instead of an "Error" title,
            // visually distinct from both the unconfigured state and any live (brighter) icon.
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
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
        this.stopVolumeAnim(context);
        this.volumeAnimState.delete(context);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosKeyVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            controller.unregisterReachabilityCallback(context);
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

        this.stopVolumeAnim(context);
        this.volumeAnimState.delete(context);
        this.actionRefs.delete(context);
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
            } catch {
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
                } catch {
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
                case 'mute': {
                    // Use the resolved new-mute value directly instead of waiting for the
                    // device's own echo (UPnP event or next poll tick) to update the icon —
                    // that echo can lag by several seconds.
                    const newMute = await controller.toggleMute();
                    const animState = this.volumeAnimState.get(action.id);
                    if (animState) {
                        animState.isMuted = newMute;
                        void this.updateIcon(action, animState.displayVolume, newMute, command);
                        void this.updateTitle(action, payload.settings, { volume: animState.volume, mute: newMute });
                    }
                    break;
                }
                case 'vol-up': await controller.volumeUp(2); break;
                case 'vol-down': await controller.volumeDown(2); break;
            }
        } catch {
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
            if (ev.payload.event === 'get-command-options') {
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-command-options',
                    items: [
                        { label: piT('-- Select Command --'), value: '' },
                        { label: piT('Mute / Preset'), value: 'mute' },
                        { label: piT('Volume Up'), value: 'vol-up' },
                        { label: piT('Volume Down'), value: 'vol-down' },
                        { label: piT('Volume Preset'), value: 'vol-preset' },
                    ],
                });
            }
        }
    }
}