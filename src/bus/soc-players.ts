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
import type { SonosBatteryStatus } from "../sonos/SonosBattery";
import { getAccentColor, knownCoverColor, setKnownCoverColor } from "../utils/color-extract";

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
        const key = ma ? `${ma.title}|${ma.artist}|${ma.cover}|${cover ? "1" : "0"}|${ma.color}` : "";
        if (externalShown.get(c.deviceIp) === key) continue;
        externalShown.set(c.deviceIp, key);
        if (!ma) {
            c.setExternalTrack(undefined);
            continue;
        }
        // The cover once it's loaded (the kit's cache); until then the last one stays as a placeholder
        if (cover && ma.color) setKnownCoverColor(cover, ma.color);
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

/**
 * The deck's player for this speaker while it plays another plugin's stream (MA-C for MA's). A
 * paused one counts too: MA's "pause" stops the speaker and empties its own queue, so its track
 * no longer looks like MA's stream (seen 2026-10-09); MA-C still claims the media while MA's
 * queue drives the speaker, and drops it once something else (the Sonos app) plays.
 */
function externalMedia(c: SonosDeviceController, merged = socPlayers.players()): Player | undefined {
    const id = coordinatorId(c);
    const p = merged.find((x) => x.device === id);
    if (!p || p.from.source === "SO-C" || !p.from.entry.media) return undefined;
    return isMusicAssistantStream(c.currentTrackUri) || c.transportState !== "PLAYING" ? p : undefined;
}

/** Whether another plugin's media drives this speaker (MA's queue): resumable even with an empty Sonos queue. */
export function playsExternalMedia(c: SonosDeviceController): boolean {
    return externalMedia(c) !== undefined;
}

/** What a speaker playing Music Assistant's stream must leave to MA itself. */
const MEDIA_TRANSPORT: readonly TransportCommand[] = ["play-pause", "play", "pause", "next", "previous"];

/**
 * While a speaker plays Music Assistant's stream, play/pause and next/previous go to MA-C. Sonos
 * commands break MA's cloud queue (seen 2026-10-09): a second "Next" left the speaker buffering,
 * then paused at 0 s; "Play" after a pause ended in a playbackError. Both times it stayed silent
 * while MA still said "playing". True when the command went to MA-C.
 */
async function sendToMedia(c: SonosDeviceController, command: TransportCommand): Promise<boolean> {
    const p = externalMedia(c);
    if (!p || !MEDIA_TRANSPORT.includes(command)) return false;
    // MA learns of a pause ~30 s late (the speaker's late report), so its own toggle would pause
    // again: the speaker's real state picks play or pause (seen 2026-10-09)
    const sent = command === "play-pause" ? (c.transportState === "PLAYING" ? "pause" : "play") : command;
    // The kit sends play/pause to the plugin that talks to the speaker (us); these go to the media's
    await socPlayers.send({ ...p, via: p.from }, sent);
    return true;
}

/** Next/Previous for a speaker (see sendToMedia). */
export async function skipTrack(c: SonosDeviceController, command: "next" | "previous"): Promise<void> {
    if (await sendToMedia(c, command)) return;
    if (command === "next") await c.next();
    else await c.previous();
}

/** Play/pause for a speaker (see sendToMedia). */
export async function togglePlayPause(c: SonosDeviceController): Promise<void> {
    if (!(await sendToMedia(c, "play-pause"))) await c.togglePlayPause();
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
    /** The music service it plays from (Sonos' name, e.g. "Spotify"), for the keys' source corner. */
    source?: string;
    /** It plays its own media (not Music Assistant's stream), from the last track it reported. */
    ownMedia?: boolean;
};

/** Battery readings of watched speakers that have one (Roam, Move), by IP. */
const batteries = new Map<string, SonosBatteryStatus | undefined>();

// Whether a speaker has a battery (set by soc-bus.ts: the probe needs discovery, which this module
// doesn't import, see setGroupMembers)
let hasBattery: (ip: string) => Promise<boolean | undefined> = async () => false;

/** Tells the players how to find out whether a speaker has a battery. */
export function setBatteryProbe(fn: (ip: string) => Promise<boolean | undefined>): void {
    hasBattery = fn;
}

/** Groups by coordinator UUID, and the watched speaker controllers by IP. */
const groups = new Map<string, Group>();
const controllers = new Map<string, SonosDeviceController>();

/** A speaker connection came up: follow its group's track, play state, play mode and volume. */
export function watchPlayers(controller: SonosDeviceController): void {
    const ip = controller.deviceIp;
    controllers.set(ip, controller);
    // Where it plays from (Sonos' service name) and, for speakers with one, the battery
    controller.registerSourceCallback(CALLBACK, (source) => {
        groupOf(controller).source = source?.service;
        publish();
    });
    void hasBattery(controller.deviceIp).then((has) => {
        if (!has || controllers.get(controller.deviceIp) !== controller) return;
        controller.registerBatteryCallback(CALLBACK, (b) => {
            batteries.set(controller.deviceIp, b);
            publish();
        });
    });
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
        // Whose media it is, from the last real track: after Music Assistant's pause the speaker
        // reports no track at all, and the stopped stream is still MA's
        const uri = controller.currentTrackUri;
        if (uri) g.ownMedia = !fromMusicAssistant(uri);
        g.cover = absoluteArt(ti.AlbumArtUri, g.host);
        void refreshPosition(controller, g);
        const art = ti.albumArtDataUri;
        const known = art && knownCoverColor(art);
        if (art && !ti.coverPending && `${art}|${known}` !== g.coverFor) {
            g.coverFor = `${art}|${known}`;
            const accent = known ? undefined : getAccentColor(art);
            if (known) g.color = known;
            else if (accent) g.color = readableCoverColor(accent);
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
    controller.unregisterSourceCallback(CALLBACK);
    controller.unregisterBatteryCallback(CALLBACK);
    batteries.delete(controller.deviceIp);
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
    if (await sendToMedia(c, command)) return;
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

/**
 * The coordinator's room name. The Sonos library throws until it has loaded a speaker's zone
 * attributes ("Zone attributes not loaded", e.g. right after a power cycle and regrouping), which
 * broke watchPlayers halfway: the group stayed "not playing" and keys failed to set up.
 */
function roomName(c: SonosDeviceController): string {
    try {
        return c.transportDevice.Name || c.deviceIp;
    } catch {
        return c.deviceIp;
    }
}

function groupOf(c: SonosDeviceController): Group {
    const coordinator = c.transportDevice;
    const id = coordinatorId(c);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, name: roomName(c), host: coordinator.Host, playing: false, since: 0 }));
    g.host = coordinator.Host;
    g.name = groupName(id, roomName(c));
    return g;
}

// A group's visible speakers by id (set by soc-bus.ts from discovery, which this module doesn't
// import: discovery starts working as soon as it is loaded)
let membersOf: (coordinatorId: string) => string[] = (id) => [id];

/** Tells the players a group's speakers; call again when the groups change. */
export function setGroupMembers(fn: (coordinatorId: string) => string[]): void {
    membersOf = fn;
    for (const c of controllers.values()) groupOf(c);
    publish();
}

/** "Küche", or "Küche + 2" for a group of three (bonded satellites don't count). */
function groupName(id: string, name: string): string {
    const members = membersOf(id).length;
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
        media: g.ownMedia ?? !fromMusicAssistant(g.trackUri),
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
        members: membersOf(g.id),
        source: g.source,
        ...batteryOf(g.id),
    };
}

/** The battery of a watched speaker in the group that has one (a Roam on its own, usually). */
function batteryOf(id: string): { battery?: number; charging?: boolean } {
    for (const c of controllers.values()) {
        const b = coordinatorId(c) === id ? batteries.get(c.deviceIp) : undefined;
        if (b) return { battery: b.percent, charging: b.charging };
    }
    return {};
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
