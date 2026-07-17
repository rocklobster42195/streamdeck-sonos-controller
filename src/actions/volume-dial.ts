import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    TouchTapEvent,
    SendToPluginEvent,
} from "@elgato/streamdeck";
import { VolumePieDialAction, VolumePieDialSettings } from "./VolumePieDialAction";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendAlignOptions, sendVizOptions } from "./pi-options";

type VolumeDialSettings = VolumePieDialSettings & {
    deviceIp?: string;
    presetVolume?: number;
    // align/showText come from VolumePieDialSettings; visualizerMode and effect-specific fields
    // (savedDensity/savedSpeed/primaryColor, written by ui/effect-fields.js) from
    // PanoramaCapableSettings underneath.
};

@action({ UUID: "de.boriskemper.sonos-controller.volume-dial" })
export class VolumeDial extends VolumePieDialAction<SonosDeviceController, VolumeDialSettings> {
    protected readonly dialLabel = 'VOLUME';

    // Rotation sends carry the absolute target volume — the device is the single speaker this
    // dial controls, so "latest target wins" is exactly right (unlike Group Volume Dial's
    // delta accumulation). Throttled (not debounced): during continuous rotation a send must go
    // out roughly every SEND_THROTTLE_MS so the actual Sonos volume keeps pace, instead of only
    // jumping once the user stops turning (which reads as "very slow" while spinning fast).
    private rotateSend: Map<string, { target: number; timer?: NodeJS.Timeout; sending: boolean; resendNeeded: boolean; lastSentAt: number }> = new Map();

    protected configuredId(settings: VolumeDialSettings): string | undefined {
        return settings.deviceIp;
    }

    protected acquireController(id: string): Promise<SonosDeviceController> {
        return sonosDeviceManager.getController(id);
    }

    protected releaseController(controller: SonosDeviceController): void {
        sonosDeviceManager.releaseController(controller.deviceIp);
    }

    protected async fetchDisplayName(controller: SonosDeviceController): Promise<string> {
        return (await controller.getZoneAttributes()).CurrentZoneName;
    }

    protected queueRotationSend(context: string, controller: SonosDeviceController, _oldVolume: number, newVolume: number): void {
        this.scheduleVolumeSend(context, controller, newVolume);
    }

    protected clearRotationSend(context: string): void {
        const entry = this.rotateSend.get(context);
        if (entry?.timer) clearTimeout(entry.timer);
        this.rotateSend.delete(context);
    }

    private scheduleVolumeSend(context: string, controller: SonosDeviceController, target: number): void {
        let entry = this.rotateSend.get(context);
        if (!entry) {
            entry = { target, sending: false, resendNeeded: false, lastSentAt: 0 };
            this.rotateSend.set(context, entry);
        } else {
            entry.target = target;
        }

        if (entry.sending) {
            entry.resendNeeded = true;
            return;
        }

        const elapsed = Date.now() - entry.lastSentAt;
        if (elapsed >= VolumePieDialAction.SEND_THROTTLE_MS) {
            if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
            void this.flushVolumeSend(context, controller);
        } else if (!entry.timer) {
            entry.timer = setTimeout(() => void this.flushVolumeSend(context, controller), VolumePieDialAction.SEND_THROTTLE_MS - elapsed);
        }
        // else: a timer is already scheduled and will pick up the latest entry.target when it fires.
    }

    private async flushVolumeSend(context: string, controller: SonosDeviceController): Promise<void> {
        const entry = this.rotateSend.get(context);
        if (!entry) return;
        entry.timer = undefined;
        entry.sending = true;
        entry.resendNeeded = false;
        entry.lastSentAt = Date.now();
        const target = entry.target;
        try {
            await controller.setVolume(target);
        } catch (e) {
            streamDeck.logger.error(`VolumeDial: error setting volume for ${context}`, e);
        } finally {
            entry.sending = false;
            this.feedbackSuppressUntil.set(context, Date.now() + VolumePieDialAction.FEEDBACK_SUPPRESS_MS);
            if (entry.resendNeeded) {
                this.scheduleVolumeSend(context, controller, entry.target);
            }
        }
    }

    override async onTouchTap(ev: TouchTapEvent<VolumeDialSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (!controller) return;

        if (ev.payload.hold) {
            // Long touch: save the current volume as the new preset.
            const volume = this.states.get(context)?.anim.targetVolume;
            if (volume === undefined) return;
            const settings: VolumeDialSettings = { ...ev.payload.settings, presetVolume: volume };
            this.settingsMap.set(context, settings);
            await ev.action.setSettings(settings);
            this.flashPresetSaved(context);
            return;
        }

        await controller.setVolume(ev.payload.settings.presetVolume ?? 50);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, VolumeDialSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-devices': await sendDeviceList(); break;
            case 'get-align-options': sendAlignOptions(); break;
            case 'get-viz-options': sendVizOptions({ label: piT('None'), value: 'none' }); break;
        }
    }
}
