// Who is late: the Sonos speaker or Music Assistant? Listens to the speaker's local WebSocket API
// (port 1443, the one Music Assistant's Sonos provider uses: playbackMetadata and playback events)
// and to Music Assistant's events at the same time, and prints when each one had the new track.
// Read-only. Reads MA_URL/MA_TOKEN from ../music-assistant-controller/.env.
//   node tools/sonos-local-latency.mjs <speaker ip> [seconds=600] [--poll]   (--poll: also ask for the
//   position every 2 s; without it only what the speaker sends by itself)
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const ip = process.argv[2];
const seconds = Number(process.argv[3] ?? 600);
const API_KEY = '123e4567-e89b-12d3-a456-426655440000';
const env = Object.fromEntries(
    readFileSync(new URL('../../music-assistant-controller/.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(8);
let lastSonosTrack = '';
let lastSonosPos = -1;
let lastMa = '';
let lastItem;

// --- the speaker's local API ---
const info = await (
    await fetch(`https://${ip}:1443/api/v1/players/local/info`, { headers: { 'X-Sonos-Api-Key': API_KEY } }).catch(() => {
        throw new Error('set NODE_TLS_REJECT_UNAUTHORIZED=0 (the speaker has a self-signed certificate)');
    })
).json();
const { householdId, groupId, playerName } = { ...info, ...info.device, householdId: info.householdId, groupId: info.groupId };
console.log(`speaker ${info.device?.name ?? playerName ?? ip}, group ${groupId}`);
const sonos = new WebSocket(`wss://${ip}:1443/websocket/api`, 'v1.api.smartspeaker.audio', { headers: { 'X-Sonos-Api-Key': API_KEY }, rejectUnauthorized: false });
let cmdId = 0;
const cmd = (namespace, command) => sonos.send(JSON.stringify([{ namespace, command, householdId, groupId, cmdId: String(++cmdId) }, {}]));
sonos.on('open', () => {
    cmd('playbackMetadata:1', 'subscribe');
    cmd('playback:1', 'subscribe');
});
sonos.on('message', (raw) => {
    const [head, body] = JSON.parse(String(raw));
    if (head.type === 'metadataStatus') {
        // A station's song is in streamInfo; a queue's track in currentItem
        const name = body?.streamInfo || body?.currentItem?.track?.name || body?.container?.name || '?';
        const next = body?.nextItem?.track?.name;
        const how = head.response ? 'asked ' : 'pushed';
        if (name !== lastSonosTrack) console.log(`${rel()}  SONOS metadata   ${how} now "${name}"${next ? ` (next "${next}")` : ''}`);
        lastSonosTrack = name;
    } else if (head.type === 'playbackStatus') {
        const pos = Math.round((body?.positionMillis ?? 0) / 1000);
        const how = head.response ? 'asked' : 'pushed';
        // A jump back (a new track starting), another queue item, or the first: worth a line
        if (pos < lastSonosPos - 5 || lastSonosPos < 0 || body?.itemId !== lastItem) console.log(`${rel()}  SONOS playback   ${how} ${body?.playbackState} position ${pos} s item ${String(body?.itemId).slice(0, 8)}`);
        lastSonosPos = pos;
        lastItem = body?.itemId;
    }
});
sonos.on('error', (e) => console.log('sonos error', e.message));

// --- Music Assistant ---
const ma = new globalThis.WebSocket(env.MA_URL.replace(/^http/, 'ws') + '/ws');
let id = 1;
ma.addEventListener('open', () => ma.send(JSON.stringify({ message_id: String(id++), command: 'auth', args: { token: env.MA_TOKEN } })));
ma.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'queue_updated' && msg.data?.queue_id === info.device?.id) {
        const name = msg.data.current_item?.media_item?.name ?? msg.data.current_item?.name;
        if (name !== lastMa) console.log(`${rel()}  MA queue         now "${name}" (elapsed ${Number(msg.data.elapsed_time ?? 0).toFixed(1)} s)`);
        lastMa = name;
    }
});

// The playback position, every 2 s, so a track start shows up even without an event
if (process.argv.includes('--poll'))
    setInterval(() => {
        cmd('playback:1', 'getPlaybackStatus');
        cmd('playbackMetadata:1', 'getMetadataStatus');
    }, 2000);
setTimeout(() => process.exit(0), seconds * 1000);
