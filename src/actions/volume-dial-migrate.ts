import type { VolumeDialSettings as KitVolumeDialSettings } from "@rocklobster42195/streamdeck-kit";
import type { JsonObject } from "@elgato/utils";
import { playerOf } from "./play-pause-migrate";

/** Sonos Controller's Volume dial settings: the universal dial's, plus the older ones (kept, so a downgrade still works). */
export type VolumeDialSettings = KitVolumeDialSettings & {
    deviceIp?: string;
    presetVolume?: number;
} & JsonObject;

/**
 * Old settings onto the universal dial's, once: the speaker becomes a deck player choice (by
 * address while discovery doesn't know it yet), the preset keeps its value (50 when never set),
 * the pie stays the default look and a tick one percent. Old keys stay in the settings.
 */
export function migrateVolumeDial(s: VolumeDialSettings, deviceOf: (ip: string) => string | undefined): VolumeDialSettings | undefined {
    if (s.player !== undefined || s.deviceIp === undefined || s.deviceIp === "") return undefined;
    const player = playerOf(s.deviceIp, deviceOf);
    return {
        ...s,
        ...(player ? { player } : {}),
        preset: s.presetVolume ?? 50,
        gauge: s.gauge ?? "pie",
        step: s.step ?? 1,
    };
}
