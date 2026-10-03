import streamDeck from "@elgato/streamdeck";
import https from "node:https";
import WebSocket from "ws";
import type { PlaybackSource } from "./SonosTypes";

// Read-only watcher on a speaker's local control API (S2, wss://<ip>:1443): the playback
// metadata of the speaker's group, for what the music was started from. UPnP no longer reports
// that for queue playback on current firmware (no EnqueuedTransportURI — checked on the user's
// Sonos Port, 2026-10-03), but this API names the container: its type (playlist, album, station),
// its service and its id. The name is sometimes generic ("Spotify playlist"); the id lets callers
// match a Sonos favorite for the real name. If the API isn't there (older speakers, S1), nothing
// is reported and callers keep their fallbacks.

/** The key the Sonos apps use for the local API. */
const API_KEY = "123e4567-e89b-12d3-a456-426655440000";
const PORT = 1443;
const RETRY_MS = [5_000, 15_000, 60_000];

type Container = { name?: string; type?: string; id?: { objectId?: string }; service?: { name?: string } };

/** The local API's container → a playback source (undefined when it names none). */
export function sourceFromContainer(c: Container | undefined): PlaybackSource | undefined {
    const title = c?.name?.trim();
    if (!c || !title) return undefined;
    const type = (c.type ?? "").toLowerCase();
    const upnpClass = type.includes("playlist") ? "object.container.playlistContainer"
        : type.includes("album") ? "object.container.album.musicAlbum"
            : type.includes("station") || type.includes("radio") ? "object.item.audioItem.audioBroadcast"
                : undefined;
    return { title, upnpClass, service: c.service?.name, objectId: c.id?.objectId };
}

export class SonosLocalApiWatcher {
    private ws?: WebSocket;
    private householdId?: string;
    private playerId?: string;
    private groupId?: string;
    private retry = 0;
    private retryTimer?: NodeJS.Timeout;
    private stopped = false;

    constructor(
        private readonly ip: string,
        private readonly onSource: (source: PlaybackSource | undefined) => void,
    ) {
        void this.connect();
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        this.ws?.removeAllListeners();
        this.ws?.close();
        this.ws = undefined;
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;
        try {
            const info = await this.localInfo();
            this.householdId = info.householdId;
            this.playerId = info.playerId;
            this.groupId = info.groupId;
        } catch {
            // No local API here (or not reachable right now)
            this.scheduleRetry();
            return;
        }
        const ws = new WebSocket(`wss://${this.ip}:${PORT}/websocket/api`, "v1.api.smartspeaker.audio", {
            rejectUnauthorized: false, // the speaker's certificate is self-signed
            headers: { "X-Sonos-Api-Key": API_KEY },
        });
        this.ws = ws;
        ws.on("open", () => {
            this.retry = 0;
            this.send("groups:1", "subscribe");
            this.subscribeMetadata();
        });
        ws.on("message", (raw) => this.onMessage(raw.toString()));
        ws.on("error", () => { /* followed by close */ });
        ws.on("close", () => {
            if (this.ws !== ws) return;
            this.ws = undefined;
            this.scheduleRetry();
        });
    }

    private onMessage(raw: string): void {
        let header: { namespace?: string; type?: string; success?: boolean };
        let body: { groups?: { id: string; coordinatorId: string; playerIds?: string[] }[]; container?: Container };
        try {
            [header, body] = JSON.parse(raw);
        } catch {
            return;
        }
        if (header.namespace === "groups:1" && Array.isArray(body.groups)) {
            const mine = body.groups.find((g) => g.coordinatorId === this.playerId || g.playerIds?.includes(this.playerId ?? ""));
            if (mine && mine.id !== this.groupId) {
                this.groupId = mine.id;
                this.subscribeMetadata();
            }
            return;
        }
        if (header.namespace === "playbackMetadata:1" && header.type === "metadataStatus") {
            this.onSource(sourceFromContainer(body.container));
        }
    }

    private subscribeMetadata(): void {
        if (!this.groupId) return;
        this.send("playbackMetadata:1", "subscribe");
    }

    private send(namespace: string, command: string): void {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify([{ namespace, command, householdId: this.householdId, groupId: this.groupId }, {}]));
    }

    private scheduleRetry(): void {
        if (this.stopped) return;
        const ms = RETRY_MS[Math.min(this.retry, RETRY_MS.length - 1)];
        this.retry++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.connect(), ms);
    }

    private localInfo(): Promise<{ householdId: string; playerId: string; groupId: string }> {
        return new Promise((resolve, reject) => {
            const req = https.get(`https://${this.ip}:${PORT}/api/v1/players/local/info`, {
                rejectUnauthorized: false,
                headers: { "X-Sonos-Api-Key": API_KEY },
                timeout: 5000,
            }, (res) => {
                let body = "";
                res.on("data", (c) => (body += c));
                res.on("end", () => {
                    try {
                        const j = JSON.parse(body);
                        if (res.statusCode !== 200 || !j.householdId) throw new Error(`HTTP ${res.statusCode}`);
                        resolve(j);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on("timeout", () => req.destroy(new Error("timeout")));
            req.on("error", (e) => {
                streamDeck.logger.debug(`[local-api ${this.ip}] not available: ${e.message}`);
                reject(e);
            });
        });
    }
}
