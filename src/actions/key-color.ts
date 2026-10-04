// A key's colour (grill 2026-10-04, the kit's resolveKeyColor): the icon of an "on" or ready key
// takes it, "off" and "not available" stay grey. Setting "keyColor": "grey" (default, the look
// from before), "cover" (what the key's speaker plays, from the players on deckbus, so also MA's
// cover while Music Assistant plays on it), "row" (the Panorama row colour of the key's Stream
// Deck) or "#RRGGBB".
import { resolveKeyColor, type Player } from "@rocklobster42195/streamdeck-kit";
import { socPlayers } from "../bus/soc-players";
import { panoramaRows } from "../effects/panorama";
import type { SonosDeviceController } from "../sonos/SonosDeviceController";

export type KeyColorSettings = { keyColor?: string };

/** The icon colour for a key: its setting, its speaker's group and its Stream Deck. */
export function keyColorOf(settings: KeyColorSettings, controller: SonosDeviceController | undefined, device: string): string {
    const choice = settings.keyColor;
    if (choice !== "cover" && choice !== "row") return resolveKeyColor(choice);
    let cover: string | undefined;
    if (choice === "cover" && controller) {
        const coordinator = controller.transportDevice;
        cover = socPlayers.resolve(`device:${coordinator.Uuid || coordinator.Host}`)?.color;
    }
    return resolveKeyColor(choice, { cover, row: choice === "row" ? panoramaRows.rowColor(device) : undefined });
}

/** Calls `fn` whenever a key colour may have changed (a cover colour, a row colour). */
export function onKeyColors(fn: () => void): () => void {
    const offs = [socPlayers.onChange(fn), panoramaRows.onRowColor(fn)];
    return () => offs.forEach((off) => off());
}

/** The icon colour for a key on another plugin's player (see remote-player.ts). */
export function keyColorOfPlayer(settings: KeyColorSettings, player: Player | undefined, device: string): string {
    const choice = settings.keyColor;
    return resolveKeyColor(choice, { cover: choice === "cover" ? player?.color : undefined, row: choice === "row" ? panoramaRows.rowColor(device) : undefined });
}
