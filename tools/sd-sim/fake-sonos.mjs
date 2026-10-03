// A stand-in Sonos system for the simulator: invented rooms, tracks, favorites and generated covers,
// answered over the same UPnP/SOAP the real speakers speak (port 1400 on loopback addresses), so
// the real plugin runs unchanged. Nothing reaches the real speakers; nothing plays anywhere.
//
//   const sonos = await startFakeSonos();   // sonos.seedIp → globalSettings.lastKnownDeviceIp
//
// Rooms: Living Room (127.0.0.2) grouped with Kitchen (127.0.0.3), Office (127.0.0.4) alone.
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const sharp = require("sharp");

/** Invented music (no real titles, no lyrics). Colours for the generated covers. */
const ALBUMS = {
    neon: { title: "Midnight Tram", artist: "Neon Harbor", album: "City Lights", colors: ["#ff5f6d", "#ffc371", "#2b1055"] },
    tide: { title: "Low Tide", artist: "Aurora Fields", album: "Salt & Glass", colors: ["#43cea2", "#185a9d", "#0b132b"] },
    ember: { title: "Ember Road", artist: "Paper Lantern Club", album: "Ember Road", colors: ["#f12711", "#f5af19", "#2d0b00"] },
    lime: { title: "Citrus Sky", artist: "Mono Garden", album: "Citrus Sky", colors: ["#a8ff78", "#78ffd6", "#1b4332"] },
    violet: { title: "Slow Orbit", artist: "Kepler Lane", album: "Slow Orbit", colors: ["#8e2de2", "#4a00e0", "#e0c3fc"] },
    dusk: { title: "Copper Hours", artist: "The Quiet Engines", album: "Copper Hours", colors: ["#b24592", "#f15f79", "#1a0b2e"] },
    frost: { title: "White Lines North", artist: "Polar Static", album: "Northbound", colors: ["#e0eafc", "#cfdef3", "#2c3e50"] },
    harbor: { title: "Harbor FM", artist: "Live radio", album: "", colors: ["#00c6ff", "#0072ff", "#001a33"] },
};
const QUEUE = [
    ["neon", "Midnight Tram"], ["tide", "Low Tide"], ["ember", "Ember Road"], ["lime", "Citrus Sky"],
    ["violet", "Slow Orbit"], ["dusk", "Copper Hours"], ["frost", "White Lines North"], ["neon", "Tram Lights Fade"],
    ["tide", "Salt and Glass"], ["ember", "Back Roads at Dawn"], ["lime", "Orange Grove"], ["violet", "Gravity Well"],
];
const FAVORITES = [
    ["Evening Jazz", "dusk", "Playlist"], ["Morning Coffee", "lime", "Playlist"], ["Harbor FM", "harbor", "Radio"],
    ["Road Trip", "ember", "Playlist"], ["Deep Focus", "frost", "Playlist"], ["Sunday Vinyl", "violet", "Album"],
];
const PLAYING = 2; // queue index (0-based) that plays
/** The invented household; the simulator pins it, so the plugin never adopts a real Sonos system. */
export const HOUSEHOLD = "Sonos_DEMO_Household";

const ROOMS = [
    { ip: "127.0.0.2", uuid: "RINCON_DEMO000000000001400", name: "Living Room", volume: 32, group: "RINCON_DEMO000000000001400" },
    { ip: "127.0.0.3", uuid: "RINCON_DEMO000000000002400", name: "Kitchen", volume: 24, group: "RINCON_DEMO000000000001400" },
    { ip: "127.0.0.4", uuid: "RINCON_DEMO000000000003400", name: "Office", volume: 18, group: "RINCON_DEMO000000000003400" },
];

const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const DIDL_OPEN = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">';

function trackItem(i, room) {
    const [albumKey, title] = QUEUE[i];
    const a = ALBUMS[albumKey];
    return `<item id="Q:0/${i + 1}" parentID="Q:0" restricted="true"><res protocolInfo="x-file-cifs:*:audio/mpeg:*" duration="0:03:${String(20 + i * 3).padStart(2, "0")}">x-file-cifs://demo/music/${i + 1}.mp3</res><upnp:albumArtURI>/getaa?s=1&amp;u=demo-${albumKey}</upnp:albumArtURI><dc:title>${esc(title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><dc:creator>${esc(a.artist)}</dc:creator><upnp:album>${esc(a.album)}</upnp:album></item>`;
}

function favoriteItem(i, room) {
    const [title, albumKey, kind] = FAVORITES[i];
    const uri = kind === "Radio" ? `x-sonosapi-stream:demo${i}?sid=254&amp;flags=8224&amp;sn=0` : `x-rincon-cpcontainer:1006206cdemo${i}`;
    const resMd = esc(`${DIDL_OPEN}<item id="demo-${i}" parentID="demo" restricted="true"><dc:title>${esc(title)}</dc:title><upnp:class>object.container.playlistContainer</upnp:class><desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">SA_RINCON2311_X_#Svc2311-0-Token</desc></item></DIDL-Lite>`);
    return `<item id="FV:2/${i + 1}" parentID="FV:2" restricted="false"><dc:title>${esc(title)}</dc:title><upnp:class>object.itemobject.item.sonos-favorite</upnp:class><r:ordinal>${i}</r:ordinal><res protocolInfo="x-rincon-cpcontainer:*:*:*">${uri}</res><upnp:albumArtURI>http://${room.ip}:1400/getaa?s=1&amp;u=demo-${albumKey}</upnp:albumArtURI><r:type>instantPlay</r:type><r:description>${kind}</r:description><r:resMD>${resMd}</r:resMD></item>`;
}

function zoneGroupState() {
    const groups = new Map();
    for (const r of ROOMS) (groups.get(r.group) ?? groups.set(r.group, []).get(r.group)).push(r);
    const xml = `<ZoneGroupState><ZoneGroups>${[...groups].map(([coord, members]) => `<ZoneGroup Coordinator="${coord}" ID="${coord}:1">${members.map((m) => `<ZoneGroupMember UUID="${m.uuid}" Location="http://${m.ip}:1400/xml/device_description.xml" ZoneName="${esc(m.name)}" Icon="" Configuration="1" SoftwareVersion="85.0" SWGen="2" Invisible="0"/>`).join("")}</ZoneGroup>`).join("")}</ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>`;
    return xml;
}

function deviceDescription(room) {
    return `<?xml version="1.0" encoding="utf-8"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>${room.ip} - Sonos Demo</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelNumber>S23</modelNumber><modelName>Sonos Demo</modelName><softwareVersion>85.0</softwareVersion><roomName>${esc(room.name)}</roomName><displayName>Demo</displayName><UDN>uuid:${room.uuid}</UDN></device></root>`;
}

/** The SOAP answer for one action (fields of the u:<Action>Response element). */
function answer(room, action, body) {
    const coordinator = ROOMS.find((r) => r.uuid === room.group) ?? room;
    const playing = QUEUE[PLAYING];
    switch (action) {
        case "GetZoneGroupState": return { ZoneGroupState: esc(zoneGroupState()) };
        case "GetHouseholdID": return { CurrentHouseholdID: HOUSEHOLD };
        case "GetTransportInfo": return { CurrentTransportState: "PLAYING", CurrentTransportStatus: "OK", CurrentSpeed: "1" };
        case "GetPositionInfo": return {
            Track: String(PLAYING + 1), TrackDuration: "0:03:41",
            TrackMetaData: esc(`${DIDL_OPEN}${trackItem(PLAYING, coordinator).replace(`id="Q:0/${PLAYING + 1}"`, 'id="-1"').replace('parentID="Q:0"', 'parentID="-1"')}</DIDL-Lite>`),
            TrackURI: `x-file-cifs://demo/music/${PLAYING + 1}.mp3`, RelTime: "0:01:12", AbsTime: "NOT_IMPLEMENTED", RelCount: "2147483647", AbsCount: "2147483647",
        };
        case "GetMediaInfo": return { NrTracks: String(QUEUE.length), MediaDuration: "NOT_IMPLEMENTED", CurrentURI: `x-rincon-queue:${coordinator.uuid}#0`, CurrentURIMetaData: "", NextURI: "", NextURIMetaData: "", PlayMedium: "NETWORK", RecordMedium: "NOT_IMPLEMENTED", WriteStatus: "NOT_IMPLEMENTED" };
        case "GetTransportSettings": return { PlayMode: "NORMAL", RecQualityMode: "NOT_IMPLEMENTED" };
        case "GetCrossfadeMode": return { CrossfadeMode: "0" };
        case "GetVolume": return { CurrentVolume: String(room.volume) };
        case "GetMute": return { CurrentMute: "0" };
        case "GetGroupVolume": return { CurrentVolume: String(Math.round(ROOMS.filter((r) => r.group === room.group).reduce((s, r) => s + r.volume, 0) / ROOMS.filter((r) => r.group === room.group).length)) };
        case "GetGroupMute": return { CurrentMute: "0" };
        case "GetZoneAttributes": return { CurrentZoneName: room.name, CurrentIcon: "", CurrentConfiguration: "1", CurrentTargetRoomName: room.name };
        case "Browse": {
            const id = /<ObjectID>([^<]*)<\/ObjectID>/.exec(body)?.[1] ?? "";
            let items = [];
            if (id.startsWith("Q:0")) items = QUEUE.map((_, i) => trackItem(i, coordinator));
            else if (id.startsWith("FV:2")) items = FAVORITES.map((_, i) => favoriteItem(i, coordinator));
            return { Result: esc(`${DIDL_OPEN}${items.join("")}</DIDL-Lite>`), NumberReturned: String(items.length), TotalMatches: String(items.length), UpdateID: "1" };
        }
        default: return {}; // commands (Play, Seek, SetVolume, …): accepted, nothing happens
    }
}

const covers = new Map();
async function cover(key) {
    if (!covers.has(key)) {
        const [a, b, c] = (ALBUMS[key] ?? ALBUMS.neon).colors;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="360" cy="150" r="90" fill="#fff" opacity="0.18"/><path d="M0 400 C 120 340, 220 470, 340 400 S 512 360, 512 360 L512 512 L0 512 Z" fill="${c}" opacity="0.7"/></svg>`;
        covers.set(key, await sharp(Buffer.from(svg)).resize(300, 300).jpeg({ quality: 85 }).toBuffer());
    }
    return covers.get(key);
}

function serve(room) {
    return http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${room.ip}:1400`);
        if (req.method === "GET" && url.pathname === "/xml/device_description.xml") {
            res.writeHead(200, { "content-type": "text/xml" }).end(deviceDescription(room));
            return;
        }
        if (req.method === "GET" && url.pathname === "/getaa") {
            const key = (url.searchParams.get("u") ?? "").replace(/^demo-/, "");
            res.writeHead(200, { "content-type": "image/jpeg" }).end(await cover(key));
            return;
        }
        if (req.method === "SUBSCRIBE") {
            // Accepted, but no events follow: the plugin keeps itself current by polling
            res.writeHead(200, { SID: `uuid:demo-${Math.random().toString(16).slice(2)}`, TIMEOUT: "Second-3600" }).end();
            return;
        }
        if (req.method === "UNSUBSCRIBE") {
            res.writeHead(200).end();
            return;
        }
        if (req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const soapAction = String(req.headers.soapaction ?? "").replace(/"/g, "");
                const [service, action] = soapAction.split("#");
                const fields = answer(room, action, body);
                const xml = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${service}">${Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</u:${action}Response></s:Body></s:Envelope>`;
                res.writeHead(200, { "content-type": 'text/xml; charset="utf-8"' }).end(xml);
            });
            return;
        }
        res.writeHead(404).end();
    });
}

/** Start the stand-in speakers; `stop()` closes them. */
export async function startFakeSonos() {
    const servers = await Promise.all(ROOMS.map((room) => new Promise((resolve, reject) => {
        const s = serve(room);
        s.once("error", reject);
        s.listen(1400, room.ip, () => resolve(s));
    })));
    return {
        seedIp: ROOMS[0].ip,
        household: HOUSEHOLD,
        rooms: ROOMS.map((r) => ({ ip: r.ip, name: r.name })),
        stop: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
    };
}
