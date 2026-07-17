import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    TouchTapEvent,
    SendToPluginEvent,
} from "@elgato/streamdeck";
import { VolumePieDialAction, VolumePieDialSettings } from "./VolumePieDialAction";
import { sonosGroupManager } from "../sonos/SonosGroupManager";
import { SonosGroupController } from "../sonos/SonosGroupController";
import { piT } from "../utils/pi-i18n";
import { sendGroupList, sendAlignOptions, sendVizOptions } from "./pi-options";

type GroupVolumeDialSettings = VolumePieDialSettings & {
    groupIp?: string;
    // Per-member volumes captured via long-touch — host -> volume. Deliberately not a single
    // absolute number: a group preset should restore each speaker's own balance (e.g. a Port at
    // 50% next to satellites at 20%), not flatten everyone to the same level.
    presetMemberVolumes?: Record<string, number>;
    // align/showText come from VolumePieDialSettings; visualizerMode and effect-specific fields
    // from PanoramaCapableSettings underneath.
};

@action({ UUID: "de.boriskemper.sonos-controller.group-volume-dial" })
export class GroupVolumeDial extends VolumePieDialAction<SonosGroupController, GroupVolumeDialSettings> {
    protected readonly dialLabel = 'GROUP';

    // Rotation sends accumulate raw tick deltas (rather than tracking an absolute target) so the
    // send never depends on a locally cached "current group volume" baseline that could go stale
    // mid-rotation and produce a wrong (jumpy) relative adjustment. Throttled (not debounced),
    // same reasoning as VolumeDial's variant.
    private rotateSend: Map<string, { pendingDelta: number; timer?: NodeJS.Timeout; sending: boolean; lastSentAt: number }> = new Map();

    protected configuredId(settings: GroupVolumeDialSettings): string | undefined {
        return settings.groupIp;
    }

    protected acquireController(id: string): Promise<SonosGroupController> {
        return sonosGroupManager.getController(id);
    }

    protected releaseController(controller: SonosGroupController): void {
        sonosGroupManager.releaseController(controller.anchorIp);
    }

    protected fetchDisplayName(controller: SonosGroupController): string {
        return controller.getGroupName();
    }

    protected queueRotationSend(context: string, controller: SonosGroupController, oldVolume: number, newVolume: number): void {
        // The delta actually applied after clamping to [0, 100] — this is what gets sent to
        // Sonos, not the absolute newVolume.
        this.scheduleVolumeAdjust(context, controller, newVolume - oldVolume);
    }

    protected clearRotationSend(context: string): void {
        const entry = this.rotateSend.get(context);
        if (entry?.timer) clearTimeout(entry.timer);
        this.rotateSend.delete(context);
    }

    private scheduleVolumeAdjust(context: string, controller: SonosGroupController, delta: number): void {
        let entry = this.rotateSend.get(context);
        if (!entry) {
            entry = { pendingDelta: delta, sending: false, lastSentAt: 0 };
            this.rotateSend.set(context, entry);
        } else {
            entry.pendingDelta += delta;
        }

        if (entry.sending) return; // flushVolumeAdjust's finally block will pick up the accumulated delta.

        const elapsed = Date.now() - entry.lastSentAt;
        if (elapsed >= VolumePieDialAction.SEND_THROTTLE_MS) {
            if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
            void this.flushVolumeAdjust(context, controller);
        } else if (!entry.timer) {
            entry.timer = setTimeout(() => void this.flushVolumeAdjust(context, controller), VolumePieDialAction.SEND_THROTTLE_MS - elapsed);
        }
        // else: a timer is already scheduled and will flush the accumulated delta when it fires.
    }

    private async flushVolumeAdjust(context: string, controller: SonosGroupController): Promise<void> {
        const entry = this.rotateSend.get(context);
        if (!entry) return;
        entry.timer = undefined;
        entry.sending = true;
        entry.lastSentAt = Date.now();
        const delta = entry.pendingDelta;
        entry.pendingDelta = 0;
        try {
            await controller.adjustVolume(delta);
        } catch (e) {
            streamDeck.logger.error(`GroupVolumeDial: error adjusting group volume for ${context}`, e);
            entry.pendingDelta += delta; // don't lose the delta — retry it along with whatever accumulates next.
        } finally {
            entry.sending = false;
            this.feedbackSuppressUntil.set(context, Date.now() + VolumePieDialAction.FEEDBACK_SUPPRESS_MS);
            if (entry.pendingDelta !== 0) {
                const elapsed = Date.now() - entry.lastSentAt;
                if (elapsed >= VolumePieDialAction.SEND_THROTTLE_MS) {
                    void this.flushVolumeAdjust(context, controller);
                } else if (!entry.timer) {
                    entry.timer = setTimeout(() => void this.flushVolumeAdjust(context, controller), VolumePieDialAction.SEND_THROTTLE_MS - elapsed);
                }
            }
        }
    }

    override async onTouchTap(ev: TouchTapEvent<GroupVolumeDialSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (!controller) return;

        if (ev.payload.hold) {
            // Long touch: save each member's current volume as the new preset.
            const snapshot = await controller.getMemberVolumeSnapshot();
            const settings: GroupVolumeDialSettings = { ...ev.payload.settings, presetMemberVolumes: snapshot };
            this.settingsMap.set(context, settings);
            await ev.action.setSettings(settings);
            this.flashPresetSaved(context);
            return;
        }

        const preset = ev.payload.settings.presetMemberVolumes;
        if (preset) await controller.recallMemberVolumes(preset);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, GroupVolumeDialSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-groups': await sendGroupList(); break;
            case 'get-align-options': sendAlignOptions(); break;
            case 'get-viz-options': sendVizOptions({ label: piT('None'), value: 'none' }); break;
        }
    }
}
