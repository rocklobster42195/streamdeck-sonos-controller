import streamDeck, {
    action,
    KeyDownEvent,
    KeyUpEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { VolumeDisplay } from "@rocklobster42195/streamdeck-kit";
import { generateFaderSvg, generateVolumeButtonIcon, generateUnreachableKeyIcon } from "../utils/icons";
import { keyColorOf, keyColorOfPlayer, onKeyColors, type KeyColorSettings } from "./key-color";
import { isRemote, RemoteKeys, remotePlayer } from "./remote-player";
import { socPlayers } from "../bus/soc-players";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { ControllerLease } from "./ControllerLease";

type SonosKeyVolumeSettings = KeyColorSettings & {
    deviceIp?: string;
    command?: 'mute' | 'vol-up' | 'vol-down' | 'vol-preset';
    volume?: number;
    presetVolume?: number;
    showVolume?: boolean;
    showPreset?: boolean;
    // How the mute key's volume is drawn: the pie (default), the kit's ring or open ring
    gauge?: 'pie' | 'ring' | 'open';
};

type VolumeCommand = SonosKeyVolumeSettings['command'];

// What the icon/title updaters actually need from an action — structural, so `ev.action` fits
// without fighting the SDK's KeyAction/DialAction union generics.
type KeySurface = {
    readonly id: string;
    readonly device?: { readonly id: string };
    setImage(image?: string): Promise<void>;
    setTitle(title?: string): Promise<void>;
};

interface KeyState {
    // Eases/fakes the fader icon's displayed volume — only the 'mute' command's icon actually
    // visualizes the level, so the animation paths are gated on that command below.
    anim: VolumeDisplay;
    isMuted: boolean;
    command?: VolumeCommand;
}

@action({ UUID: "de.boriskemper.sonos-controller.volume-control-key" })
export class VolumeControlKey extends SingletonAction<SonosKeyVolumeSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private initializedHash: Map<string, string> = new Map();
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private longPressExecuted: Map<string, boolean> = new Map();
    private actionRefs: Map<string, KeySurface> = new Map();
    private keyStates: Map<string, KeyState> = new Map();
    private gauges: Map<string, SonosKeyVolumeSettings['gauge']> = new Map();
    private keySettings: Map<string, SonosKeyVolumeSettings> = new Map();
    /** Keys on another plugin's player (drawn from deckbus, commands go there). */
    private remote = new RemoteKeys((context) => this.drawRemote(context));

    constructor() {
        super();
        // A cover or row colour changed: draw again in the key colour
        onKeyColors(() => {
            for (const context of this.keySettings.keys()) this.redraw(context);
        });
    }

    private redraw(context: string): void {
        if (this.remote.has(context)) return this.drawRemote(context);
        const s = this.keyStates.get(context);
        const a = this.actionRefs.get(context);
        if (s && a) void this.updateIcon(a, s.anim.current(), s.isMuted, s.command);
    }

    /** The icon colour: grey as before, or the key colour (grill 2026-10-04). */
    private colorOf(action: KeySurface): string {
        const settings = this.keySettings.get(action.id);
        if (!settings) return '#CCCCCC';
        if (this.remote.has(action.id)) return keyColorOfPlayer(settings, isRemote(settings.deviceIp) ? remotePlayer(settings.deviceIp) : undefined, action.device?.id ?? '');
        return keyColorOf(settings, this.lease.get(action.id), action.device?.id ?? '');
    }

    /** A key on another plugin's player: its volume and mute from deckbus. */
    private drawRemote(context: string): void {
        const action = this.actionRefs.get(context);
        const settings = this.keySettings.get(context);
        if (!action || !settings || !isRemote(settings.deviceIp)) return;
        const p = remotePlayer(settings.deviceIp);
        if (!p) {
            void action.setImage(generateUnreachableKeyIcon());
            return;
        }
        const volume = p.volume ?? 0;
        void this.updateIcon(action, volume, !!p.muted, settings.command);
        void this.updateTitle(action, settings, { volume, mute: !!p.muted });
    }

    /** What a press controls: the Sonos connection, or another plugin's player over deckbus. */
    private targetOf(context: string): { setVolume(v: number): Promise<unknown>; toggleMute(): Promise<boolean>; volumeUp(step: number): Promise<unknown>; volumeDown(step: number): Promise<unknown> } | undefined {
        const settings = this.keySettings.get(context);
        if (!this.remote.has(context) || !isRemote(settings?.deviceIp)) return this.lease.get(context);
        const p = remotePlayer(settings.deviceIp);
        if (!p) return undefined;
        return {
            setVolume: (v) => socPlayers.send(p, 'volume', v),
            toggleMute: async () => {
                await socPlayers.send(p, 'mute', !p.muted);
                return !p.muted;
            },
            volumeUp: (step) => socPlayers.send(p, 'volume-by', step),
            volumeDown: (step) => socPlayers.send(p, 'volume-by', -step),
        };
    }

    private gaugeOf(action: KeySurface): SonosKeyVolumeSettings['gauge'] {
        return this.gauges.get(action.id) ?? 'pie';
    }

    private newKeyState(context: string, volume: number, isMuted: boolean, command: VolumeCommand): KeyState {
        const state: KeyState = {
            anim: new VolumeDisplay(() => {
                const s = this.keyStates.get(context);
                const a = this.actionRefs.get(context);
                if (!s || !a) return;
                void this.updateIcon(a, s.anim.current(), s.isMuted, s.command);
            }),
            isMuted,
            command,
        };
        state.anim.initialize(volume);
        return state;
    }

    private clearKeyState(context: string): void {
        this.keyStates.get(context)?.anim.stop();
        this.keyStates.delete(context);
    }

    private async updateIcon(action: KeySurface | undefined, volume: number, isMuted: boolean, command?: VolumeCommand) {
        if (!action) return;

        let iconFile = '';
        const color = this.colorOf(action);
        const basePath = 'imgs/actions/volume-control-key/';

        switch (command) {
            case 'mute':
                iconFile = generateFaderSvg(volume, isMuted, isMuted ? "#CCCCCC" : color, this.gaugeOf(action));
                break;
            case 'vol-up':
                iconFile = generateVolumeButtonIcon('up', color);
                break;
            case 'vol-down':
                iconFile = generateVolumeButtonIcon('down', color);
                break;
            case 'vol-preset':
                iconFile = generateVolumeButtonIcon('preset', color);
                break;
            default:
                iconFile = `${basePath}volume-high-cccccc.png`;
                break;
        }

        await action.setImage(iconFile);
    }

    private async updateTitle(action: KeySurface, settings: SonosKeyVolumeSettings, volume: { volume: number, mute: boolean }) {
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
        this.gauges.set(context, settings.gauge);
        this.keySettings.set(context, settings);

        this.actionRefs.set(context, action);

        const preset = presetVolume ?? volume;
        const currentHash = `${deviceIp}-${command}-${preset}-${showVolume}-${showPreset}`;
        // Another plugin's player: no Sonos connection, drawn from deckbus
        if (isRemote(deviceIp)) {
            this.lease.release(context);
            this.initializedHash.delete(context);
            this.clearKeyState(context);
            this.remote.add(context);
            if (!command) await action.setTitle("Config...");
            this.drawRemote(context);
            return;
        }
        this.remote.delete(context);

        if (this.initializedHash.get(context) === currentHash) {
            // Only the look changed (gauge, colour)
            this.redraw(context);
            return;
        }

        await discoveryPromise;

        // Always release the previous reference before reacquiring — even when deviceIp is
        // unchanged. acquire() below unconditionally increments its refCount, so acquiring
        // without a matching prior release (as this used to do whenever only some other
        // setting changed) leaked one refCount per settings change: the underlying
        // SonosDeviceController's polling/event timers then never got torn down even after
        // this key was removed, since onWillDisappear only releases once. Must also run when
        // the config was CLEARED (early return below) — otherwise the old controller stayed
        // registered/refcounted despite the key no longer being configured.
        this.lease.release(context);

        if (!deviceIp || !command) {
            await action.setTitle("Config...");
            return;
        }

        try {
            const controller = await this.lease.acquire(context, deviceIp, (controller) => {
                controller.registerReachabilityCallback(context, (reachable) => {
                    if (reachable) {
                        void this.onInstanceUpdate(ev);
                    } else {
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });

                // Matches the original isReachable-gated ordering below: the remaining callbacks
                // are only registered when the device is already known reachable at registration.
                if (controller.isReachable) {
                    // Only the 'mute' command's fader icon visualizes volume — other commands
                    // ignore fade-state signals entirely.
                    controller.registerFadeStateCallback(context, (fading, durationMs) => {
                        const state = this.keyStates.get(context);
                        if (!state || state.command !== 'mute') return;
                        state.anim.onFadeState(fading, durationMs);
                    });

                    controller.registerVolumeCallback(context, (volume) => {
                        let state = this.keyStates.get(context);
                        if (!state) {
                            state = this.newKeyState(context, volume.volume, volume.mute, command);
                            this.keyStates.set(context, state);
                        }
                        state.isMuted = volume.mute;
                        state.command = command;
                        if (command === 'mute') {
                            // onEcho eases the fader toward the new value — and ignores echoes
                            // while a fade is running (those are the coarse steps the fake
                            // descent hides).
                            state.anim.onEcho(volume.volume);
                        } else {
                            // Static icons — keep the target in sync (no animation) and repaint directly.
                            state.anim.initialize(volume.volume);
                            this.updateIcon(action, volume.volume, volume.mute, command);
                        }
                        this.updateTitle(action, settings, volume);
                    });
                }

                return [
                    () => controller.unregisterVolumeCallback(context),
                    () => controller.unregisterFadeStateCallback(context),
                    () => controller.unregisterReachabilityCallback(context),
                ];
            });

            // Bails out if the device is ALREADY unreachable at registration time, before any of
            // the callback registrations/renders below get a chance to overwrite the placeholder
            // just set above. Same fix as MultiControlKey's identical bug (2026-07-18).
            if (!controller.isReachable) return;

            // Set initial icon (snap, no animation on first render)
            const currentVolume = await controller.getVolume();
            this.clearKeyState(context);
            this.keyStates.set(context, this.newKeyState(context, currentVolume.volume, currentVolume.mute, command));
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
        const controller = this.lease.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            controller.unregisterFadeStateCallback(context);
        }

        this.initializedHash.delete(context);
        this.clearKeyState(context);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosKeyVolumeSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        this.lease.release(context);
        this.initializedHash.delete(context);

        const timer = this.timers.get(context);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(context);
        }
        this.longPressExecuted.delete(context);

        this.clearKeyState(context);
        this.actionRefs.delete(context);
        this.keySettings.delete(context);
        this.remote.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosKeyVolumeSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.targetOf(action.id);
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
        const controller = this.targetOf(action.id);

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
                    if (this.remote.has(action.id)) break;
                    const state = this.keyStates.get(action.id);
                    if (state) {
                        state.isMuted = newMute;
                        void this.updateIcon(action, state.anim.current(), newMute, command);
                        void this.updateTitle(action, payload.settings, { volume: Math.round(state.anim.targetVolume ?? 0), mute: newMute });
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

}
