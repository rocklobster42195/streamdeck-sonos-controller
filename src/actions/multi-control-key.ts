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
import { ControllerLease } from "./ControllerLease";
import { SonosBatteryStatus, deviceHasBattery } from "../sonos/SonosBattery";
import { deviceHasLineIn } from "../sonos/SonosLineIn";
import { generateLineInIcon, generateBatteryKeyIcon, generateUnreachableKeyIcon } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendFadeOptions, sendOptions } from "./pi-options";

// MS1 scope so far: Line-In (one-shot source switch, optional fade beforehand) and Battery
// (full-key status display, key press = manual refresh). Night Mode/Speech Enhancement/Sleep
// Timer are planned but not yet built — see docs/concept-multicontrol-key.md.
type MultiControlFunction = 'line-in' | 'battery';

// What renderIcon actually needs from an action — structural, so both `ev.action` and
// streamDeck.actions.getActionById() results fit without fighting the SDK's generics.
type ImageTarget = { setImage(image?: string): Promise<void> };

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
    // Same mechanism as hasBattery, but for Line-In: a real, hardware-verified positive probe
    // (deviceHasLineIn — see SonosLineIn.ts, confirmed 2026-07-17 against 8 live devices) rather
    // than the hasBattery-only negative proxy this used to rely on, which offered Line-In on
    // every mains-powered device without the port (Play:1, One, SYMFONISK, ...).
    hasLineIn?: boolean;
};

// Whether a function is valid for THIS device, based on the two hardware-probed capability
// signals. Both now require a POSITIVE confirmation before being offered — battery used to accept
// "not yet known" (hasBattery !== false) as good enough, which raced against the PI's own initial
// 'get-function-options' request: that request can arrive before onInstanceUpdate's probe
// resolves, when both flags are still undefined, and an asymmetric default (Line-In excluded
// while unknown, Battery included while unknown) meant the dropdown briefly offered "Battery" on
// devices that turned out not to have one — confirmed on hardware (Küche/SYMFONISK: dropdown
// showed "Battery" at the same time the noFunctionAvailableItem hint said no function was
// available). Both probes are cheap and already run on every settings sync regardless, so there's
// no reason left to default-permissive for either.
function isFunctionValid(fn: MultiControlFunction, hasBattery: boolean | undefined, hasLineIn: boolean | undefined): boolean {
    if (fn === 'line-in') return hasLineIn === true;
    if (fn === 'battery') return hasBattery === true;
    return true;
}

// Empty (no function valid for this device) is surfaced via the placeholder's own text rather
// than silently leaving a nearly-empty dropdown — see also noFunctionAvailableItem in the PI,
// which shows a fuller explanatory hint for the same condition.
function functionOptionItems(hasBattery: boolean | undefined, hasLineIn: boolean | undefined): { label: string; value: string }[] {
    const validFns = (['line-in', 'battery'] as const).filter((fn) => isFunctionValid(fn, hasBattery, hasLineIn));
    if (validFns.length === 0) {
        return [{ label: piT('-- No function available for this device --'), value: '' }];
    }
    return [
        { label: piT('-- Select Function --'), value: '' },
        ...validFns.map((fn) => ({ label: piT(fn === 'line-in' ? 'Line-In' : 'Battery'), value: fn })),
    ];
}

@action({ UUID: "de.boriskemper.sonos-controller.multi-control-key" })
export class MultiControlKey extends SingletonAction<MultiControlSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private setupRetry = new SetupRetryScheduler();
    private batteryStatuses: Map<string, SonosBatteryStatus | undefined> = new Map();
    // Last known hasBattery per context — read by the get-function-options handler below, since
    // that request arrives without direct access to the settings object being computed in
    // onInstanceUpdate.
    private hasBatteryByContext: Map<string, boolean> = new Map();
    // Same purpose as hasBatteryByContext, for Line-In — read by the get-function-options
    // handler below.
    private hasLineInByContext: Map<string, boolean> = new Map();
    // Last known deviceIp per context — lets onInstanceUpdate tell "device actually changed" apart
    // from "instance just (re)appeared with its persisted device", so the function selection only
    // resets on a real device switch, not on every plugin/PI restart.
    private lastDeviceIpByContext: Map<string, string> = new Map();
    // Guards against Stream Deck re-sending onWillAppear/onDidReceiveSettings for a tile that's
    // already correctly set up — confirmed on hardware (2026-07-18): Stream Deck can re-send
    // onWillAppear for tiles that are already visible, with no user action and no actual settings
    // change, repeatedly and for many tiles/devices near-simultaneously. Each full onInstanceUpdate
    // rebuild does real network work (release+reacquire the controller, deviceHasBattery/
    // deviceHasLineIn probes, GENA re-subscribe), which compounds into noticeable lag. A DIFFERENT
    // concern from lastDeviceIpByContext above (that one tells "device actually changed" apart to
    // gate whether controlFunction resets — still needed even when this guard doesn't fire, e.g.
    // after a genuine settings change). Deliberately only wraps onWillAppear/onDidReceiveSettings
    // (the actual Stream Deck entry points) — the reachability callback's own "reachable:true"
    // branch and setupRetry call onInstanceUpdate directly, so a real recovery rebuild after the
    // device comes back online is unaffected. The settings-resync re-entry via action.setSettings()
    // (see onInstanceUpdate's own comment) also isn't affected: it arrives as a genuine
    // onDidReceiveSettings with different settings (hasBattery/hasLineIn now filled in), so the
    // JSON comparison here naturally doesn't match and lets it through.
    private lastAppliedSettingsJson: Map<string, string> = new Map();
    // Tracks, per context, whether THIS context's own reachability callback last reported the
    // device unreachable and hasn't yet seen a recovery — deliberately NOT controller.isReachable
    // (a device-global flag driven by the background poll loop's own ~8s cadence). Using that flag
    // to gate onBatteryChanged's repaint caused a regression on hardware (2026-07-18, mass restart
    // across 9 devices): a battery callback fires SYNCHRONOUSLY with the cached status the moment
    // it's registered during onInstanceUpdate's own initial setup, and the laggy poll-driven flag
    // could still read stale-false from an earlier hiccup even though this same setup already
    // proved reachability moments before — silently skipping the tile's only initial icon render
    // (controlFunction === 'battery' has no other render path) and leaving it stuck blank. See
    // PlayPauseKey's identical fix for the full writeup.
    private unreachableContexts: Set<string> = new Set();

    private skipRedundantUpdate(context: string, settings: MultiControlSettings): boolean {
        const settingsJson = JSON.stringify(settings);
        if (this.lease.has(context) && this.lastAppliedSettingsJson.get(context) === settingsJson) {
            return true;
        }
        this.lastAppliedSettingsJson.set(context, settingsJson);
        return false;
    }

    private renderIcon(action: ImageTarget | undefined, context: string, controlFunction: MultiControlFunction | undefined): void {
        if (!action) return;
        if (controlFunction === 'battery') {
            void action.setImage(generateBatteryKeyIcon(this.batteryStatuses.get(context)));
        } else if (controlFunction === 'line-in') {
            void action.setImage(generateLineInIcon());
        }
    }

    private onBatteryChanged(context: string, battery: SonosBatteryStatus | undefined): void {
        // The independent battery-poll loop has no network call of its own to naturally fail
        // while unreachable (unlike e.g. a transport-state refresh) — without this check, a
        // battery update arriving right after the reachability callback set the unreachable
        // placeholder would repaint straight over it. Same class of bug as PlayPauseKey's
        // identical fix (2026-07-18, confirmed on hardware for a powered-off battery Roam).
        // Gated on unreachableContexts (this context's own last-known state), not
        // controller.isReachable — see that field's own doc comment for why.
        if (this.unreachableContexts.has(context)) return;
        this.batteryStatuses.set(context, battery);
        this.renderIcon(streamDeck.actions.getActionById(context), context, 'battery');
    }

    private async onInstanceUpdate(ev: WillAppearEvent<MultiControlSettings> | DidReceiveSettingsEvent<MultiControlSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        this.setupRetry.cancel(context);
        let settings = payload.settings;
        const { deviceIp } = settings;

        this.lease.release(context);
        this.batteryStatuses.delete(context);

        await discoveryPromise;

        // Computed even before a function is chosen (deviceIp alone is enough) — the PI needs
        // this in place before the user opens the function dropdown, otherwise a function would
        // be offered for one render pass on a device that doesn't actually support it.
        // setSettings() below re-enters onDidReceiveSettings once, exactly like play-pause-key.ts's
        // same pattern, but terminates immediately on the second pass since both flags then match.
        if (deviceIp) {
            const [hasBatteryResult, hasLineInResult] = await Promise.all([deviceHasBattery(deviceIp), deviceHasLineIn(deviceIp)]);
            // undefined means "couldn't determine right now" (e.g. the device is temporarily
            // unreachable/asleep, not currently in sonosManager.Devices at all) — preserve
            // whatever was last known instead of collapsing to false, which otherwise treats
            // "can't check right now" the same as "confirmed no Battery/Line-In hardware" and
            // wipes a still-valid function selection purely because the device happened to be
            // offline at this exact moment. Confirmed on hardware (2026-07-18): a battery Roam
            // that was asleep had its saved "Battery" function silently reset to empty this way.
            // Falls back to the PERSISTED settings.hasBattery/hasLineIn (not just the in-memory
            // hasBatteryByContext/hasLineInByContext maps) — those maps start empty on every
            // fresh plugin process, so right after a restart, on a device whose discovery hasn't
            // completed yet (common with several devices restarting near-simultaneously), the old
            // in-memory-only fallback still collapsed to false and wiped the function anyway.
            // Confirmed on hardware (2026-07-18): a mass restart across 9 devices left several
            // MultiControlKey tiles reset to "Config..." despite the real device answering fine
            // moments later.
            const hasBattery = hasBatteryResult ?? settings.hasBattery ?? this.hasBatteryByContext.get(context) ?? false;
            const hasLineIn = hasLineInResult ?? settings.hasLineIn ?? this.hasLineInByContext.get(context) ?? false;
            const changed = this.hasBatteryByContext.get(context) !== hasBattery || this.hasLineInByContext.get(context) !== hasLineIn;
            this.hasBatteryByContext.set(context, hasBattery);
            this.hasLineInByContext.set(context, hasLineIn);

            // A real device switch (not the instance just re-appearing with its already-persisted
            // device) restarts the function choice from scratch — a function valid for the OLD
            // device (e.g. Line-In on a Play:5) is meaningless context carried over to a newly
            // picked device, even if it happens to still be technically valid there too. Also
            // covers the narrower case where the function became invalid for the SAME device
            // (e.g. a capability probe result changed) without a device switch.
            const deviceChanged = this.lastDeviceIpByContext.has(context) && this.lastDeviceIpByContext.get(context) !== deviceIp;
            this.lastDeviceIpByContext.set(context, deviceIp);
            const staleFunction = !!settings.controlFunction && (deviceChanged || !isFunctionValid(settings.controlFunction, hasBattery, hasLineIn));

            if (settings.hasBattery !== hasBattery || settings.hasLineIn !== hasLineIn || staleFunction) {
                settings = { ...settings, hasBattery, hasLineIn, ...(staleFunction ? { controlFunction: undefined } : {}) };
                await action.setSettings(settings);
            }
            if (changed) {
                // Re-render the actual dropdown list, not just the settings-synced warning hint —
                // the PI may already have the (stale) list loaded from before these were known,
                // e.g. right after the device dropdown changed while the PI was still open.
                sendOptions('get-function-options', functionOptionItems(hasBattery, hasLineIn));
            }
        }

        const controlFunction = settings.controlFunction;
        if (!deviceIp || !controlFunction) {
            await action.setTitle("Config...");
            return;
        }

        try {
            const controller = await this.lease.acquire(context, deviceIp, (controller) => {
                controller.registerReachabilityCallback(context, (reachable) => {
                    if (reachable) {
                        this.unreachableContexts.delete(context);
                        void this.onInstanceUpdate(ev);
                    } else {
                        this.unreachableContexts.add(context);
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });
                // Matches the original isReachable-gated ordering below: battery is only
                // registered here when the device is already known reachable at registration time.
                if (controlFunction === 'battery' && controller.isReachable) {
                    controller.registerBatteryCallback(context, (battery) => this.onBatteryChanged(context, battery));
                }
                return [
                    () => controller.unregisterReachabilityCallback(context),
                    () => controller.unregisterBatteryCallback(context),
                ];
            });

            // Bails out if the device is ALREADY unreachable at registration time (confirmed on
            // hardware, 2026-07-18: a tile pointed at an already-down Sonos Roam showed no
            // unreachable icon at all) — the unconditional icon render below would otherwise
            // immediately overwrite the placeholder just set above. The reachable branch above
            // already re-enters via onInstanceUpdate, so nothing else needs to run.
            if (!controller.isReachable) return;

            await action.setTitle("");

            if (controlFunction !== 'battery') {
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
        if (this.skipRedundantUpdate(ev.action.id, ev.payload.settings)) return;
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<MultiControlSettings>): Promise<void> {
        if (this.skipRedundantUpdate(ev.action.id, ev.payload.settings)) return;
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<MultiControlSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        this.lease.release(context);
        this.batteryStatuses.delete(context);
        this.hasBatteryByContext.delete(context);
        this.hasLineInByContext.delete(context);
        this.lastAppliedSettingsJson.delete(context);
        this.unreachableContexts.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<MultiControlSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.lease.get(action.id);
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
            case 'get-devices': await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp); break;
            case 'get-function-options':
                sendOptions('get-function-options', functionOptionItems(this.hasBatteryByContext.get(ev.action.id), this.hasLineInByContext.get(ev.action.id)));
                break;
            case 'get-fade-options': sendFadeOptions(); break;
        }
    }
}
