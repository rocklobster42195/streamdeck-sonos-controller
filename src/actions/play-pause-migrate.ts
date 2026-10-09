import type { PlayPauseKeySettings } from "@rocklobster42195/streamdeck-kit";
import { PLAYER_PREFIX } from "./remote-player";

/** Sonos Controller's Play/Pause key settings before the universal key (kit grill 2026-10-09). */
type LegacySettings = {
    deviceIp?: string;
    showDeviceName?: boolean;
    showCoverArt?: boolean;
    showTrackTitle?: boolean;
    fontColor?: string;
    fontSize?: number;
    batteryDisplayMode?: "off" | "warning" | "full";
    hasBattery?: boolean;
};
export type PlayPauseSettings = PlayPauseKeySettings & LegacySettings;

/** A speaker the key was bound to by address, until its id is known (a speaker that was offline). */
export const SONOS_IP_PREFIX = "sonos-ip:";

/**
 * Old settings onto the universal key's, once (undefined: nothing to do). A speaker becomes its
 * device ("device:RINCON_…"; by address while it isn't known yet), another plugin's player its
 * choice. The look stays: no corners, except the battery for a speaker that has one (grill Q8c).
 */
export function migratePlayPause(s: PlayPauseSettings, deviceOf: (ip: string) => string | undefined): PlayPauseSettings | undefined {
    if (s.topLeft !== undefined || s.topRight !== undefined) return undefined;
    const { deviceIp, showDeviceName, showCoverArt, showTrackTitle, fontColor, fontSize, batteryDisplayMode, hasBattery, ...rest } = s;
    void fontColor;
    void fontSize;
    let player: string | undefined;
    if (deviceIp?.startsWith(PLAYER_PREFIX)) player = deviceIp.slice(PLAYER_PREFIX.length) || undefined;
    else if (deviceIp) {
        const device = deviceOf(deviceIp);
        player = device ? `device:${device}` : `${SONOS_IP_PREFIX}${deviceIp}`;
    }
    const mode = batteryDisplayMode ?? "warning";
    const battery = hasBattery === true && mode !== "off";
    return {
        ...rest,
        ...(player ? { player } : {}),
        topLeft: "none",
        topRight: battery ? "battery" : "none",
        battery: mode === "full" ? "always" : "low",
        showCover: showCoverArt !== false,
        showTitle: !!showTrackTitle,
        showProgress: !!s.showProgress,
        showName: !!showDeviceName,
    };
}
