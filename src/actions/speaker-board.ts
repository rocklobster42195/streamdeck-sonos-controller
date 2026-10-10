// The Volume dial's players: the deck's (deck-players.ts), except that a dial bound to one of
// SO-C's speakers shows and sets that speaker's OWN volume and mute, with its room's name, even
// while it plays in a group (as the dial always did; the group's volume is the Group Volume dial's).
// The deck's players are groups, so this keeps its own controller per speaker.
import type { Player, PlayerBoard } from "@rocklobster42195/streamdeck-kit";
import type { SonosDeviceController } from "../sonos/SonosDeviceController";
import { safeDevices } from "../sonos/sonos-discovery";
import { deckPlayers } from "./deck-players";
import { SONOS_IP_PREFIX } from "./play-pause-migrate";

/** Which speaker a player choice means (its address), when it is one of SO-C's: "device:<id>" or "sonos-ip:<ip>". */
export function speakerIpOf(choice: string | undefined): string | undefined {
    if (!choice) return undefined;
    if (choice.startsWith(SONOS_IP_PREFIX)) return choice.slice(SONOS_IP_PREFIX.length);
    if (!choice.startsWith("device:")) return undefined;
    const id = choice.slice("device:".length);
    return safeDevices().find((d) => d.Uuid === id)?.Host;
}

const SPEAKER = Symbol("speaker");
type SpeakerPlayer = Player & { [SPEAKER]?: SonosDeviceController };

/** The speakers the dials hold a controller for, by player choice. */
const held = new Map<string, SonosDeviceController>();

export function holdSpeaker(choice: string, controller: SonosDeviceController): void {
    held.set(choice, controller);
}

export function dropSpeaker(choice: string, controller: SonosDeviceController): void {
    if (held.get(choice) === controller) held.delete(choice);
}

function roomName(ip: string): string {
    try {
        return safeDevices().find((d) => d.Host === ip)?.Name || ip;
    } catch {
        return ip;
    }
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export const speakerBoard: Pick<PlayerBoard, "resolve" | "send" | "onChange" | "status"> = {
    resolve(choice) {
        const base = deckPlayers.resolve(choice);
        const c = choice ? held.get(choice) : undefined;
        if (!c || !choice) return base;
        const own: SpeakerPlayer = {
            ...(base ?? ({ player: choice, kind: "speaker", playing: false, since: 0, routes: [], via: undefined, from: undefined } as unknown as Player)),
            id: choice,
            name: roomName(c.deviceIp),
            volume: c.liveVolume,
            muted: c.liveMuted,
            can: ["volume", "volume-by", "mute"],
            [SPEAKER]: c,
        };
        return own;
    },
    async send(target, command, value) {
        const c = typeof target === "object" ? (target as SpeakerPlayer | undefined)?.[SPEAKER] : undefined;
        if (!c) return deckPlayers.send(target, command, value);
        if (command === "volume") return c.setVolume(clamp(value as number));
        if (command === "volume-by") return c.setVolume(clamp(c.liveVolume + (value as number)));
        if (command === "mute") return c.setMute(!!value);
        throw new Error(`speaker: ${command} is not a speaker command`);
    },
    onChange: (fn) => deckPlayers.onChange(fn),
    status: (p, now) => deckPlayers.status(p, now),
};
