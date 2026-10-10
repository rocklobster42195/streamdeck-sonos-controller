// The deck's players as SO-C's universal keys see them (Play/Pause, Playback Control): SO-C's
// PlayerBoard, plus keys moved over while their speaker was offline, which are bound by address
// ("sonos-ip:…") and find the speaker once discovery knows it.
import { socPlayers } from "../bus/soc-players";
import { safeDevices } from "../sonos/sonos-discovery";
import { SONOS_IP_PREFIX } from "./play-pause-migrate";

/** A speaker's id by its address, once discovery knows it. */
export function deviceOf(ip: string): string | undefined {
    return safeDevices().find((d) => d.Host === ip)?.Uuid || undefined;
}

/**
 * The deck's players as the key sees them: a key moved over while its speaker was offline is bound
 * by address ("sonos-ip:…") and finds the speaker once it's back.
 */
export const deckPlayers: Pick<typeof socPlayers, "resolve" | "send" | "onChange" | "status"> = {
    resolve: (choice) => {
        if (!choice?.startsWith(SONOS_IP_PREFIX)) return socPlayers.resolve(choice);
        const device = deviceOf(choice.slice(SONOS_IP_PREFIX.length));
        return device ? socPlayers.resolve(`device:${device}`) : undefined;
    },
    send: (target, command, value) => socPlayers.send(target, command, value),
    onChange: (fn) => socPlayers.onChange(fn),
    status: (p, now) => socPlayers.status(p, now),
};

