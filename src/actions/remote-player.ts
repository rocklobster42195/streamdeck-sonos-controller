// Keys on another plugin's player (grill 2026-10-04, step 4b): a transport key's speaker setting
// can name a player on deckbus instead of a Sonos speaker: "player:active" (the active speaker),
// "player:active:all" or "player:<choice>" (e.g. "player:MA-C/up89e13563", the SHIELD in Music
// Assistant). Such a key draws from the players on deckbus and sends its commands there; a Sonos
// speaker stays on SO-C's own connection as before.
import { ACTIVE_ANY_PLAYER, ACTIVE_PLAYER, type Player } from "@rocklobster42195/streamdeck-kit";
import { socPlayers } from "../bus/soc-players";
import { safeDevices } from "../sonos/sonos-discovery";

export const PLAYER_PREFIX = "player:";

/** True when the speaker setting names a player on deckbus. */
export function isRemote(deviceIp: string | undefined): deviceIp is string {
    return !!deviceIp && deviceIp.startsWith(PLAYER_PREFIX);
}

/** The player a remote key controls right now (the active one may change). */
export function remotePlayer(deviceIp: string): Player | undefined {
    return socPlayers.resolve(deviceIp.slice(PLAYER_PREFIX.length) || ACTIVE_PLAYER);
}

/** Whether other plugins offer players besides the Sonos speakers (then the PI says "Device", not "Sonos device"). */
export function hasOtherPlayers(): boolean {
    const sonos = new Set(safeDevices().map((d) => d.Uuid));
    return socPlayers.players().some((p) => !(p.device && sonos.has(p.device)) && p.routes.some((r) => r.source !== "SO-C"));
}

/** The dropdown entries after the Sonos speakers: "Active player", "Active player, also apps" (music on the computer, from SA-C), then other plugins' players. */
export function remoteItems(currentValue?: string): { label: string; value: string; sub?: string }[] {
    const sonos = new Set(safeDevices().map((d) => d.Uuid));
    const items: { label: string; value: string; sub?: string }[] = [
        { label: "kit.player_active", value: `${PLAYER_PREFIX}${ACTIVE_PLAYER}` },
        { label: "kit.player_active_all", value: `${PLAYER_PREFIX}${ACTIVE_ANY_PLAYER}` },
    ];
    for (const p of socPlayers.players()) {
        // Sonos speakers are in the list above already (by their address)
        if (p.device && sonos.has(p.device)) continue;
        items.push({ label: `${p.playing ? "▶ " : ""}${p.name}`, value: `${PLAYER_PREFIX}${p.id}`, sub: [...new Set(p.routes.map((r) => r.source))].join(" · ") });
    }
    if (isRemote(currentValue) && !items.some((i) => i.value === currentValue)) items.push({ label: currentValue.slice(PLAYER_PREFIX.length), value: currentValue, sub: "–" });
    return items;
}

/** Keys showing a remote player: draws each again whenever the players change. */
export class RemoteKeys {
    private readonly contexts = new Set<string>();

    constructor(draw: (context: string) => void) {
        socPlayers.onChange(() => {
            for (const context of this.contexts) draw(context);
        });
    }

    add(context: string): void {
        this.contexts.add(context);
    }

    delete(context: string): void {
        this.contexts.delete(context);
    }

    has(context: string): boolean {
        return this.contexts.has(context);
    }
}
