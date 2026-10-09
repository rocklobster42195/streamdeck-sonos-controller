// SO-C's speakers on deckbus: state "players" (the kit's players.ts, grill 2026-10-04) and, for
// Panorama rows of older peers, "covers". One entry per group (its coordinator, "Küche + 2"), with
// the coordinator's RINCON id as device id, so a Sonos speaker that Music Assistant also knows is
// one player on the deck; SO-C talks to it directly, so commands for it come here. Fed by the
// speaker connections SO-C has open anyway (for its visible actions): no extra connections.
import { CoverBoard, PlayerBoard, getCachedCover, loadCover, readableCoverColor, type CoverEntry, type Player, type PlayerEntry, type RepeatMode, type Transport, type TransportCommand } from "@rocklobster42195/streamdeck-kit";
import streamDeck from "@elgato/streamdeck";
import type { SonosDeviceController } from "../sonos/SonosDeviceController";
import { parsePlayMode, toPlayMode } from "../sonos/play-mode";
import { isMusicAssistantStream, type TrackInfo } from "../sonos/SonosTypes";
import { formatRelTime, parseRelTime } from "../sonos/rel-time";
import { getAccentColor } from "../utils/color-extract";

export const socCovers = new CoverBoard("SO-C");
export const socPlayers = new PlayerBoard("SO-C");

/** Per coordinator: the title/cover last handed to its controllers as the external track. */
const externalShown = new Map<string, string>();

/**
 * While a speaker plays Music Assistant's stream, SO-C's keys and dials show what MA-C publishes
 * for it on deckbus: the speaker itself reports MA's tracks 18–40 s late (measured 2026-10-09:
 * MA's web player under 1 s), and MA-C knows the track that really plays (its TrackAdvance).
 */
function syncExternalTracks(): void {
    const merged = socPlayers.players();
    for (const c of controllers.values()) {
        const from = externalMedia(c, merged)?.from;
        const ma = from?.entry.title ? from.entry : undefined;
        const cover = ma?.cover ? getCachedCover(ma.cover) : undefined;
        const key = ma ? `${ma.title}|${ma.artist}|${ma.cover}|${cover ? "1" : "0"}` : "";
        if (externalShown.get(c.deviceIp) === key) continue;
        externalShown.set(c.deviceIp, key);
        if (!ma) {
            c.setExternalTrack(undefined);
            continue;
        }
        // The cover once it's loaded (the kit's cache); until then the last one stays as a placeholder
        if (ma.cover && !cover) void loadCover(ma.cover).then((uri) => uri && syncExternalTracks());
        c.setExternalTrack({
            Title: ma.title,
            Artist: ma.artist,
            Album: ma.album,
            AlbumArtUri: ma.cover,
            albumArtDataUri: cover,
            coverPending: !cover,
            isRadio: false,
        } as TrackInfo);
    }
}
socPlayers.onChange(syncExternalTracks);

/** The deck's player for this speaker while it plays another plugin's stream (MA-C for MA's). */
function externalMedia(c: SonosDeviceController, merged = socPlayers.players()): Player | undefined {
    const id = coordinatorId(c);
    const p = merged.find((x) => x.device === id);
    return p && p.from.source !== "SO-C" && p.from.entry.media && isMusicAssistantStream(c.currentTrackUri) ? p : undefined;
}

/**
 * Next/Previous for a speaker. While it plays Music Assistant's stream they go to MA-C (the kit
 * routes them to the media's plugin): a Sonos "Next" in MA's cloud queue works once, the next one
 * leaves the speaker buffering, then paused at 0 s while MA still says "playing" (seen 2026-10-09).
 */
export async function skipTrack(c: SonosDeviceController, command: "next" | "previous"): Promise<void> {
    const p = externalMedia(c);
    if (p) await socPlayers.send(p, command);
    else if (command === "next") await c.next();
    else await c.previous();
}

const CALLBACK = "soc-players";

type Group = {
    id: string;
    name: string;
    host: string;
    color?: string;
    coverFor?: string;
    playing: boolean;
    since: number;
    title?: string;
    artist?: string;
    album?: string;
    cover?: string;
    isRadio?: boolean;
    trackUri?: string;
    position?: number;
    duration?: number;
    at?: number;
    playMode?: string;
};

/** Groups by coordinator UUID, and the watched speaker controllers by IP. */
const groups = new Map<string, Group>();
const controllers = new Map<string, SonosDeviceController>();

/** A speaker connection came up: follow its group's track, play state, play mode and volume. */
export function watchPlayers(controller: SonosDeviceController): void {
    const ip = controller.deviceIp;
    controllers.set(ip, controller);
    controller.registerTransportStateCallback(CALLBACK, (ts) => {
        const g = groupOf(controller);
        const playing = ts === "PLAYING";
        if (playing && !g.playing) g.since = Date.now();
        g.playing = playing;
        void refreshPosition(controller, g);
        publish();
    });
    controller.registerTrackInfoCallback(CALLBACK, (ti) => {
        const g = groupOf(controller);
        g.title = ti.Title || undefined;
        g.artist = ti.Artist || undefined;
        g.album = ti.Album || undefined;
        g.isRadio = ti.isRadio;
        g.trackUri = ti.TrackUri;
        g.cover = absoluteArt(ti.AlbumArtUri, g.host);
        void refreshPosition(controller, g);
        const art = ti.albumArtDataUri;
        if (art && !ti.coverPending && art !== g.coverFor) {
            g.coverFor = art;
            const accent = getAccentColor(art);
            if (accent) g.color = readableCoverColor(accent);
        }
        publish();
    });
    controller.registerPlayModeCallback(CALLBACK, (mode) => {
        groupOf(controller).playMode = mode;
        publish();
    });
    controller.registerVolumeCallback(CALLBACK, () => publish());
    const ts = controller.transportState;
    if (ts) {
        const g = groupOf(controller);
        g.playing = ts === "PLAYING";
        if (g.playing) g.since = Date.now();
    }
    publish();
}

/** The speaker connection goes: forget its group when no other watched speaker is in it. */
export function unwatchPlayers(controller: SonosDeviceController): void {
    controller.unregisterTransportStateCallback(CALLBACK);
    controller.unregisterTrackInfoCallback(CALLBACK);
    controller.unregisterPlayModeCallback(CALLBACK);
    controller.unregisterVolumeCallback(CALLBACK);
    controllers.delete(controller.deviceIp);
    const kept = new Set([...controllers.values()].map((c) => coordinatorId(c)));
    for (const id of [...groups.keys()]) if (!kept.has(id)) groups.delete(id);
    publish();
}

/** Commands for SO-C's own players, from its own keys and from other plugins (deckbus "transport"). */
socPlayers.serve(async ({ player, command, value }: Transport) => {
    const c = controllerFor(player);
    if (!c) throw new Error(`transport: ${player} is not connected`);
    const dev = c.transportDevice;
    const g = groups.get(player);
    switch (command) {
        case "play-pause": return void (await c.togglePlayPause());
        case "play": return void (await dev.Play());
        case "pause": return void (await dev.Pause());
        case "next": return void (await c.next());
        case "previous": return void (await c.previous());
        case "seek":
            await dev.AVTransportService.Seek({ InstanceID: 0, Unit: "REL_TIME", Target: formatRelTime(Math.max(0, value as number)) });
            if (g) {
                g.position = value as number;
                g.at = Date.now();
                publish();
            }
            return;
        case "volume": return void (await dev.GroupRenderingControlService.SetGroupVolume({ InstanceID: 0, DesiredVolume: clampVolume(value as number) }));
        case "volume-by": return void (await dev.GroupRenderingControlService.SetRelativeGroupVolume({ InstanceID: 0, Adjustment: Math.round(value as number) }));
        case "mute": return void (await dev.GroupRenderingControlService.SetGroupMute({ InstanceID: 0, DesiredMute: value as boolean }));
        case "shuffle":
        case "repeat": {
            const mode = g?.playMode ?? String((await dev.AVTransportService.GetTransportSettings({ InstanceID: 0 })).PlayMode);
            const { shuffle, repeat } = parsePlayMode(mode);
            const next = command === "shuffle" ? toPlayMode(value as boolean, repeat) : toPlayMode(shuffle, value as RepeatMode);
            await dev.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: next as never });
            if (g) {
                g.playMode = next;
                publish();
            }
            return;
        }
    }
}, { failed: (t, e) => streamDeck.logger.warn(`[deckbus] ${t.command} on ${t.player} failed`, e) });

function coordinatorId(c: SonosDeviceController): string {
    const coordinator = c.transportDevice;
    return coordinator.Uuid || coordinator.Host;
}

function groupOf(c: SonosDeviceController): Group {
    const coordinator = c.transportDevice;
    const id = coordinatorId(c);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, name: coordinator.Name || c.deviceIp, host: coordinator.Host, playing: false, since: 0 }));
    g.host = coordinator.Host;
    g.name = groupName(id, coordinator.Name || c.deviceIp);
    return g;
}

// How many visible speakers a group has (set by soc-bus.ts from discovery, which this module
// doesn't import: discovery starts working as soon as it is loaded)
let membersOf: (coordinatorId: string) => number = () => 1;

/** Tells the players how to count a group's speakers; call again when the groups change. */
export function setGroupMembers(fn: (coordinatorId: string) => number): void {
    membersOf = fn;
    for (const c of controllers.values()) groupOf(c);
    publish();
}

/** "Küche", or "Küche + 2" for a group of three (bonded satellites don't count). */
function groupName(id: string, name: string): string {
    const members = membersOf(id);
    return members > 1 ? `${name} + ${members - 1}` : name;
}

/** A watched controller in the group: the coordinator's own if we have it, else any member's. */
function controllerFor(id: string): SonosDeviceController | undefined {
    const all = [...controllers.values()].filter((c) => coordinatorId(c) === id);
    return all.find((c) => c.deviceIp === c.transportDevice.Host) ?? all[0];
}

async function refreshPosition(c: SonosDeviceController, g: Group): Promise<void> {
    try {
        const pos = await c.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
        g.position = parseRelTime(pos.RelTime);
        g.duration = parseRelTime(pos.TrackDuration) || undefined;
        g.at = Date.now();
        publish();
    } catch {
        /* some sources report no position */
    }
}

function absoluteArt(uri: string | undefined, host: string): string | undefined {
    if (!uri) return undefined;
    return /^https?:\/\//.test(uri) ? uri : `http://${host}:1400${uri.startsWith("/") ? "" : "/"}${uri}`;
}

const clampVolume = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** Music Assistant streams to Sonos from its own stream server (port 8097): then MA's data is the better source. */
const fromMusicAssistant = isMusicAssistantStream;

function entryOf(g: Group): PlayerEntry {
    const c = controllerFor(g.id);
    const { shuffle, repeat } = parsePlayMode(g.playMode);
    const canSeek = !g.isRadio && !!g.duration;
    const can: TransportCommand[] = g.isRadio
        ? ["play-pause", "play", "pause", "volume", "volume-by", "mute"]
        : ["play-pause", "play", "pause", "next", "previous", "volume", "volume-by", "mute", "shuffle", "repeat", ...(canSeek ? (["seek"] as const) : [])];
    const coordinator = c && c.deviceIp === c.transportDevice.Host ? c : undefined;
    return {
        player: g.id,
        device: g.id,
        name: g.name,
        kind: "speaker",
        direct: true,
        media: !fromMusicAssistant(g.trackUri),
        playing: g.playing,
        since: g.since,
        color: g.color,
        title: g.title,
        artist: g.artist,
        album: g.album,
        cover: g.cover,
        position: g.position,
        duration: g.duration,
        at: g.at,
        volume: coordinator?.liveVolume,
        muted: coordinator?.liveMuted,
        shuffle: g.isRadio ? undefined : shuffle,
        repeat: g.isRadio ? undefined : repeat,
        can,
    };
}

function publish(): void {
    const covers: CoverEntry[] = [];
    const players: PlayerEntry[] = [];
    for (const g of groups.values()) {
        if (g.color) covers.push({ player: g.id, name: g.name, color: g.color, playing: g.playing, since: g.since, device: g.id, direct: true });
        players.push(JSON.parse(JSON.stringify(entryOf(g))) as PlayerEntry);
    }
    socCovers.publish(covers);
    socPlayers.publish(players);
}
