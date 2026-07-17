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
import { discoveryPromise } from "../sonos/sonos-discovery";
import { SonosBatteryStatus, deviceHasBattery } from "../sonos/SonosBattery";
import { generateLineInIcon, generateBatteryKeyIcon, generateUnreachableKeyIcon } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendFadeOptions, sendOptions } from "./pi-options";

// MS1 scope so far: Line-In (one-shot source switch, optional fade beforehand) and Battery
// (full-key status display, key press = manual refresh). Night Mode/Speech Enhancement/Sleep
// Timer are planned but not yet built — see docs/concept-multicontrol-key.md.
type MultiControlFunction = 'line-in' | 'battery';

type MultiControlSettings = {
    deviceIp?: string;
    controlFunction?: MultiControlFunction;
    fadeDuration?: string; // seconds as string from the PI select, Line-In only — "0"/undefined = no fade
    // Computed on every settings sync (see onInstanceUpdate) and written back via setSettings() so
    // the PI can react to it through the settings-sync channel (a hidden
    // <sdpi-checkbox setting="hasBattery">, see battery-capability.js's wireBatteryCapabilityOption)
    // to hide the "Battery" function option for devices that don't report battery data — same
    // pattern as play-pause-key.ts's batteryDisplayMode field gating.
    hasBattery?: boolean;
};

// Whether a function is valid for a device we know has a battery (Roam/Move) — reuses the
// hasBattery signal we already compute, rather than a separate Line-In capability check (which
// has no cheap signal at all, see docs/concept-multicontrol-key.md's capability-gating section).
// Sonos' battery-powered speakers (Roam/Move) have no physical Line-In port, so hasBattery is a
// reliable NEGATIVE signal for Line-In even though it says nothing positive about mains-powered
// devices (those still default to "offered", consistent with the plugin's general MS1 policy of
// offering a function unless there's positive evidence against it).
function isFunctionValid(fn: MultiControlFunction, hasBattery: boolean | undefined): boolean {
    if (fn === 'line-in') return hasBattery !== true;
    if (fn === 'battery') return hasBattery !== false;
    return true;
}

function functionOptionItems(hasBattery: boolean | undefined): { label: string; value: string }[] {
    const items = [{ label: piT('-- Select Function --'), value: '' }];
    (['line-in', 'battery'] as const).forEach((fn) => {
        if (isFunctionValid(fn, hasBattery)) {
            items.push({ label: piT(fn === 'line-in' ? 'Line-In' : 'Battery'), value: fn });
        }
    });
    return items;
}

@action({ UUID: "de.boriskemper.sonos-controller.multi-control-key" })
export class MultiControlKey extends SingletonAction<MultiControlSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private setupRetry = new SetupRetryScheduler();
    private batteryStatuses: Map<string, SonosBatteryStatus | undefined> = new Map();
    // Last known hasBattery per context — read by the get-function-options handler below, since
    // that request arrives without direct access to the settings object being computed in
    // onInstanceUpdate.
    private hasBatteryByContext: Map<string, boolean> = new Map();
    // Last known deviceIp per context — lets onInstanceUpdate tell "device actually changed" apart
    // from "instance just (re)appeared with its persisted device", so the function selection only
    // resets on a real device switch, not on every plugin/PI restart.
    private lastDeviceIpByContext: Map<string, string> = new Map();

    private renderIcon(action: any, context: string, controlFunction: MultiControlFunction | undefined): void {
        if (!action) return;
        if (controlFunction === 'battery') {
            void action.setImage(generateBatteryKeyIcon(this.batteryStatuses.get(context)));
        } else if (controlFunction === 'line-in') {
            void action.setImage(generateLineInIcon());
        }
    }

    private onBatteryChanged(context: string, battery: SonosBatteryStatus | undefined): void {
        this.batteryStatuses.set(context, battery);
        this.renderIcon(streamDeck.actions.getActionById(context), context, 'battery');
    }

    private async onInstanceUpdate(ev: WillAppearEvent<MultiControlSettings> | DidReceiveSettingsEvent<MultiControlSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        this.setupRetry.cancel(context);
        let settings = payload.settings;
        const { deviceIp } = settings;

        const oldController = this.controllers.get(context);
        if (oldController) {
            oldController.unregisterReachabilityCallback(context);
            oldController.unregisterBatteryCallback(context);
            sonosDeviceManager.releaseController(oldController.deviceIp);
            this.controllers.delete(context);
        }
        this.batteryStatuses.delete(context);

        await discoveryPromise;

        // Computed even before a function is chosen (deviceIp alone is enough) — the PI needs
        // this in place before the user opens the function dropdown, otherwise "Battery" would be
        // offered for one render pass on a non-battery device. setSettings() below re-enters
        // onDidReceiveSettings once, exactly like play-pause-key.ts's same pattern, but terminates
        // immediately on the second pass since hasBattery then matches.
        if (deviceIp) {
            const hasBattery = await deviceHasBattery(deviceIp);
            const changed = this.hasBatteryByContext.get(context) !== hasBattery;
            this.hasBatteryByContext.set(context, hasBattery);

            // A real device switch (not the instance just re-appearing with its already-persisted
            // device) restarts the function choice from scratch — a function valid for the OLD
            // device (e.g. Line-In on a Play:5) is meaningless context carried over to a newly
            // picked device, even if it happens to still be technically valid there too. Also
            // covers the narrower case where the function became invalid for the SAME device
            // (e.g. hasBattery detection changed) without a device switch.
            const deviceChanged = this.lastDeviceIpByContext.has(context) && this.lastDeviceIpByContext.get(context) !== deviceIp;
            this.lastDeviceIpByContext.set(context, deviceIp);
            const staleFunction = !!settings.controlFunction && (deviceChanged || !isFunctionValid(settings.controlFunction, hasBattery));

            if (settings.hasBattery !== hasBattery || staleFunction) {
                settings = { ...settings, hasBattery, ...(staleFunction ? { controlFunction: undefined } : {}) };
                await action.setSettings(settings);
            }
            if (changed) {
                // Re-render the actual dropdown list, not just the settings-synced warning hint —
                // the PI may already have the (stale) list loaded from before hasBattery was known,
                // e.g. right after the device dropdown changed while the PI was still open.
                sendOptions('get-function-options', functionOptionItems(hasBattery));
            }
        }

        const controlFunction = settings.controlFunction;
        if (!deviceIp || !controlFunction) {
            await action.setTitle("Config...");
            return;
        }

        try {
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

            await action.setTitle("");

            if (controlFunction === 'battery') {
                controller.registerBatteryCallback(context, (battery) => this.onBatteryChanged(context, battery));
            } else {
                this.renderIcon(action, context, controlFunction);
            }
        } catch (e) {
            streamDeck.logger.error(`Error in onInstanceUpdate [${context}]:`, e);
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
        }
    }

    override async onWillAppear(ev: WillAppearEvent<MultiControlSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MultiControlSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<MultiControlSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterReachabilityCallback(context);
            controller.unregisterBatteryCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
        this.batteryStatuses.delete(context);
        this.hasBatteryByContext.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<MultiControlSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.controllers.get(action.id);
        const { controlFunction, fadeDuration } = payload.settings;

        if (!controller || !controlFunction) {
            action.showAlert();
            return;
        }

        try {
            switch (controlFunction) {
                case 'line-in': {
                    const fadeMs = (Number(fadeDuration) || 0) * 1000;
                    // A multi-second fade shouldn't leave the key without feedback — confirm the
                    // press immediately, same reasoning as Play Favorite's fade (see play-favorite-key.ts).
                    if (fadeMs > 0) action.showOk();
                    await controller.switchToLineInWithFade(fadeMs);
                    if (fadeMs <= 0) action.showOk();
                    break;
                }
                case 'battery':
                    await controller.refreshBatteryStatus();
                    action.showOk();
                    break;
            }
        } catch (e) {
            streamDeck.logger.error("Error handling MultiControlKey press:", e);
            action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, MultiControlSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch ((ev.payload as any).event) {
            case 'get-devices': await sendDeviceList(); break;
            case 'get-function-options':
                sendOptions('get-function-options', functionOptionItems(this.hasBatteryByContext.get(ev.action.id)));
                break;
            case 'get-fade-options': sendFadeOptions(); break;
        }
    }
}
