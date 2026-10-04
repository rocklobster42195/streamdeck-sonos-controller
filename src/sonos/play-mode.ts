// Sonos play modes <-> shuffle + repeat (deckbus "players"). Note: SHUFFLE in the Sonos API means
// shuffle + repeat all.
import type { RepeatMode } from "@rocklobster42195/streamdeck-kit";

export function parsePlayMode(mode: string | undefined): { shuffle: boolean; repeat: RepeatMode } {
    switch (mode) {
        case "REPEAT_ALL": return { shuffle: false, repeat: "all" };
        case "REPEAT_ONE": return { shuffle: false, repeat: "one" };
        case "SHUFFLE_NOREPEAT": return { shuffle: true, repeat: "off" };
        // SHUFFLE in the Sonos API means shuffle + repeat all
        case "SHUFFLE": return { shuffle: true, repeat: "all" };
        case "SHUFFLE_REPEAT_ONE": return { shuffle: true, repeat: "one" };
        default: return { shuffle: false, repeat: "off" };
    }
}

export function toPlayMode(shuffle: boolean, repeat: RepeatMode): string {
    if (shuffle) return repeat === "all" ? "SHUFFLE" : repeat === "one" ? "SHUFFLE_REPEAT_ONE" : "SHUFFLE_NOREPEAT";
    return repeat === "all" ? "REPEAT_ALL" : repeat === "one" ? "REPEAT_ONE" : "NORMAL";
}
