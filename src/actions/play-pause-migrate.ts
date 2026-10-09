import type { PlaybackKeySettings, PlayPauseKeySettings, VolumeCommand, VolumeKeySettings } from "@rocklobster42195/streamdeck-kit";
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

/** A key's old `deviceIp` onto a deck player choice: a speaker's device (by address until known), another plugin's player as it was. */
export function playerOf(deviceIp: string | undefined, deviceOf: (ip: string) => string | undefined): string | undefined {
    if (!deviceIp) return undefined;
    if (deviceIp.startsWith(PLAYER_PREFIX)) return deviceIp.slice(PLAYER_PREFIX.length) || undefined;
    const device = deviceOf(deviceIp);
    return device ? `device:${device}` : `${SONOS_IP_PREFIX}${deviceIp}`;
}

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
    const player = playerOf(deviceIp, deviceOf);
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

/** Sonos Controller's Playback Control key settings, with the older `deviceIp`. */
export type PlaybackSettings = PlaybackKeySettings & { deviceIp?: string };

/** Old settings onto the universal key's, once: the speaker becomes a deck player choice; command, seek step and colour stay. */
export function migratePlayback(s: PlaybackSettings, deviceOf: (ip: string) => string | undefined): PlaybackSettings | undefined {
    if (s.deviceIp === undefined) return undefined;
    const { deviceIp, ...rest } = s;
    const player = playerOf(deviceIp, deviceOf);
    return { ...rest, ...(player ? { player } : {}) };
}

/** Sonos Controller's Volume key settings, with the older ones. */
export type VolumeSettings = VolumeKeySettings & { deviceIp?: string; presetVolume?: number; volume?: number; showPreset?: boolean };
/** As stored before: older command names ("vol-up", "vol-down", "vol-preset"). */
type OldVolumeSettings = Omit<VolumeSettings, "command"> & { command?: string };

const OLD_COMMANDS: Record<string, VolumeCommand> = { "vol-up": "up", "vol-down": "down", "vol-preset": "preset", mute: "mute" };

/**
 * Old settings onto the universal key's, once. The look and feel stays: 2 % per press (as before),
 * the preset, the number only when it was on, the pie for the mute key.
 */
export function migrateVolume(s: OldVolumeSettings, deviceOf: (ip: string) => string | undefined): VolumeSettings | undefined {
    if (s.deviceIp === undefined && !(s.command && s.command in OLD_COMMANDS && s.command !== "mute")) return undefined;
    const { deviceIp, presetVolume, volume, showPreset, ...rest } = s;
    void showPreset;
    const player = playerOf(deviceIp, deviceOf);
    const preset = presetVolume ?? volume;
    return {
        ...rest,
        ...(player ? { player } : {}),
        command: OLD_COMMANDS[s.command ?? "mute"] ?? (s.command as VolumeCommand),
        step: 2,
        ...(preset !== undefined ? { preset } : {}),
        showVolume: !!s.showVolume,
        gauge: s.gauge ?? "pie",
    };
}
