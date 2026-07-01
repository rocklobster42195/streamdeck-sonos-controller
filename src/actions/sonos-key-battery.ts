import streamDeck, {
    action,
    KeyDownEvent,
    KeyUpEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
    SendToPluginEvent,
} from "@elgato/streamdeck";
import { type JsonValue } from "@elgato/utils";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import {
    mdiBattery, mdiBattery10, mdiBattery30, mdiBattery50, mdiBattery70,
    mdiBatteryCharging10, mdiBatteryCharging30, mdiBatteryCharging50,
    mdiBatteryCharging70, mdiBatteryCharging100,
    mdiBatteryChargingWireless, mdiBatteryChargingWireless10, mdiBatteryChargingWireless30,
    mdiBatteryChargingWireless50, mdiBatteryChargingWireless70,
    mdiLock,
} from "@mdi/js";

type Settings = { deviceIp?: string; };

interface BatteryState {
    charge: number;
    powerSource: string;
    buttonLocked: boolean;
    ledOn: boolean;
}

function pickBatteryIcon(charge: number, powerSource: string): { path: string; color: string } {
    const isWireless = powerSource === 'CHARGING_RING';
    const isUsb = powerSource === 'USB';
    const chargeColor = '#4FC3F7';

    if (isWireless) {
        if (charge > 75) return { path: mdiBatteryChargingWireless, color: chargeColor };
        if (charge > 50) return { path: mdiBatteryChargingWireless70, color: chargeColor };
        if (charge > 25) return { path: mdiBatteryChargingWireless50, color: chargeColor };
        if (charge > 10) return { path: mdiBatteryChargingWireless30, color: chargeColor };
        return { path: mdiBatteryChargingWireless10, color: chargeColor };
    }
    if (isUsb) {
        if (charge > 75) return { path: mdiBatteryCharging100, color: chargeColor };
        if (charge > 50) return { path: mdiBatteryCharging70, color: chargeColor };
        if (charge > 25) return { path: mdiBatteryCharging50, color: chargeColor };
        if (charge > 10) return { path: mdiBatteryCharging30, color: chargeColor };
        return { path: mdiBatteryCharging10, color: chargeColor };
    }
    // Discharging
    if (charge > 75) return { path: mdiBattery,   color: '#44CC44' };
    if (charge > 50) return { path: mdiBattery70,  color: '#44CC44' };
    if (charge > 25) return { path: mdiBattery50,  color: '#FFCC00' };
    if (charge > 10) return { path: mdiBattery30,  color: '#FF8800' };
    return             { path: mdiBattery10, color: '#FF4444' };
}

function buildBatterySvg(state: BatteryState): string {
    const { path, color } = pickBatteryIcon(state.charge, state.powerSource);
    const lockOverlay = state.buttonLocked
        ? `<g transform="translate(60,4) scale(1.5)"><path fill="#FFD700" d="${mdiLock}"/></g>`
        : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
        + `<rect width="100" height="100" fill="#0a0a0a"/>`
        + `<g transform="translate(10,3) scale(3.3)"><path fill="${color}" d="${path}"/></g>`
        + lockOverlay
        + `<text x="50" y="94" fill="${color}" font-family="Arial,sans-serif" font-size="19"`
        + ` font-weight="bold" text-anchor="middle">${state.charge}%</text>`
        + `</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

async function fetchBattery(ip: string): Promise<{ charge: number; powerSource: string } | null> {
    try {
        const res = await fetch(`http://${ip}:1400/status/batterystatus`,
            { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const xml = await res.text();
        const charge = parseInt(xml.match(/<BatteryCharge>(\d+)<\/BatteryCharge>/)?.[1] ?? '', 10);
        const powerSource = xml.match(/<PowerSource>(\w+)<\/PowerSource>/)?.[1] ?? 'BATTERY';
        if (isNaN(charge)) return null;
        return { charge, powerSource };
    } catch {
        return null;
    }
}

@action({ UUID: "de.boriskemper.sonos-controller.sonos-key-battery" })
export class SonosKeyBattery extends SingletonAction<Settings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private listeners: Map<string, (evt: any) => void> = new Map();
    private states: Map<string, BatteryState> = new Map();
    private pollTimers: Map<string, NodeJS.Timeout> = new Map();
    private longPressTimers: Map<string, NodeJS.Timeout> = new Map();
    private longPressExecuted: Map<string, boolean> = new Map();

    private async renderKey(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction) return;
        const state = this.states.get(context);
        if (!state) return;
        await sdAction.setImage(buildBatterySvg(state));
        await sdAction.setTitle('');
    }

    private cleanupInstance(context: string): void {
        const poll = this.pollTimers.get(context);
        if (poll) { clearInterval(poll); this.pollTimers.delete(context); }
        const lt = this.longPressTimers.get(context);
        if (lt) { clearTimeout(lt); this.longPressTimers.delete(context); }
        const controller = this.controllers.get(context);
        if (controller) {
            const listener = this.listeners.get(context);
            if (listener) {
                controller.sonosDevice.DevicePropertiesService.Events.removeListener('serviceEvent', listener);
                this.listeners.delete(context);
            }
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }
        this.states.delete(context);
        this.longPressExecuted.delete(context);
    }

    private async onInstanceUpdate(ev: WillAppearEvent<Settings> | DidReceiveSettingsEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;
        this.cleanupInstance(context);

        if (!settings.deviceIp) {
            await ev.action.setTitle('Config...');
            return;
        }

        await discoveryPromise;

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            const batt = await fetchBattery(settings.deviceIp);
            if (!batt) {
                // Not a battery device — show static icon
                await ev.action.setTitle('N/A');
                sonosDeviceManager.releaseController(settings.deviceIp);
                this.controllers.delete(context);
                return;
            }

            const [lockResp, ledResp] = await Promise.all([
                controller.sonosDevice.DevicePropertiesService.GetButtonLockState(),
                controller.sonosDevice.DevicePropertiesService.GetLEDState(),
            ]);

            const state: BatteryState = {
                charge: batt.charge,
                powerSource: batt.powerSource,
                buttonLocked: lockResp.CurrentButtonLockState === 'On',
                ledOn: ledResp.CurrentLEDState === 'On',
            };
            this.states.set(context, state);

            const listener = (evt: any) => {
                const s = this.states.get(context);
                if (!s) return;
                if (evt.ButtonLockState != null) s.buttonLocked = evt.ButtonLockState === 'On';
                if (evt.LEDState != null) s.ledOn = evt.LEDState === 'On';
                void this.renderKey(context);
            };
            this.listeners.set(context, listener);
            controller.sonosDevice.DevicePropertiesService.Events.on('serviceEvent', listener);

            const poll = setInterval(async () => {
                const s = this.states.get(context);
                if (!s) return;
                const b = await fetchBattery(settings.deviceIp!);
                if (b) { s.charge = b.charge; s.powerSource = b.powerSource; }
                void this.renderKey(context);
            }, 60_000);
            this.pollTimers.set(context, poll);

            await this.renderKey(context);
        } catch (e) {
            streamDeck.logger.error(`SonosBatteryKey: error for ${settings.deviceIp}`, e);
            await ev.action.setTitle('Error');
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
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (!controller) return;

        // Long press (500 ms): toggle LED
        const timer = setTimeout(async () => {
            const state = this.states.get(context);
            if (!state) return;
            try {
                const next = !state.ledOn;
                await controller.sonosDevice.DevicePropertiesService.SetLEDState({
                    DesiredLEDState: next ? 'On' : 'Off',
                });
                state.ledOn = next;
                this.longPressExecuted.set(context, true);
                await this.renderKey(context);
            } catch (e) { streamDeck.logger.warn('SetLEDState failed', e); }
        }, 500);
        this.longPressTimers.set(context, timer);
    }

    override async onKeyUp(ev: KeyUpEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const timer = this.longPressTimers.get(context);
        if (timer) { clearTimeout(timer); this.longPressTimers.delete(context); }
        if (this.longPressExecuted.get(context)) { this.longPressExecuted.delete(context); return; }

        // Short press: toggle button lock
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;
        try {
            const next = !state.buttonLocked;
            await controller.sonosDevice.DevicePropertiesService.SetButtonLockState({
                DesiredButtonLockState: next ? 'On' : 'Off',
            });
            state.buttonLocked = next;
            await this.renderKey(context);
        } catch (e) { streamDeck.logger.warn('SetButtonLockState failed', e); }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        if (ev.payload.event === 'get-devices') {
            await discoveryPromise;
            const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
            streamDeck.ui.sendToPropertyInspector({ event: 'get-devices', items });
        }
    }
}
