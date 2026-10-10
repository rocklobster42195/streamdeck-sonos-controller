import type { TrackDialSettings as KitTrackDialSettings } from "@rocklobster42195/streamdeck-kit";
import type { JsonObject } from "@elgato/utils";
import { playerOf } from "./play-pause-migrate";

/** Sonos Controller's Track dial settings: the universal dial's, plus the older ones (kept, so a downgrade still works). */
export type TrackDialSettings = KitTrackDialSettings & {
    deviceIp?: string;
    /** 'none' | 'eq' | an effect id (the row's Panorama, see effects/panorama.ts) */
    visualizerMode?: string;
    showTrackTitle?: boolean;
    /** 'off' | 'warning' (while low) | 'full'; shown when the speaker has a battery. */
    batteryDisplayMode?: "off" | "warning" | "full";
} & JsonObject;

/**
 * Old settings onto the universal dial's, once: the speaker becomes a deck player choice (by
 * address while discovery doesn't know it yet), the Equalizer stays the Equalizer, the title switch
 * stays. The cover stays on the right. Old keys stay in the settings (downgrade-safe).
 */
export function migrateTrackDial(s: TrackDialSettings, deviceOf: (ip: string) => string | undefined): TrackDialSettings | undefined {
    if (s.player !== undefined || s.deviceIp === undefined || s.deviceIp === "") return undefined;
    const player = playerOf(s.deviceIp, deviceOf);
    return {
        ...s,
        ...(player ? { player } : {}),
        look: s.visualizerMode === "eq" || s.visualizerMode === undefined ? "eq" : "info",
        coverSide: "right",
        ...(s.showTrackTitle !== undefined ? { showTitle: s.showTrackTitle } : {}),
    };
}
