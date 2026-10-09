// When does a Sonos speaker say what it plays, compared with Music Assistant? Subscribes to the
// speaker's own UPnP events (AVTransport: track metadata, transport state), skips to the next track
// through MA's API every <n> seconds, and prints per skip when MA and when Sonos knew the new title.
// Reads MA_URL/MA_TOKEN from ../music-assistant-controller/.env. Changes nothing but the track.
//   node tools/sonos-latency.mjs <coordinator RINCON id> [seconds=200] [--next 40]
import { readFileSync } from 'node:fs';
import { SonosManager, SonosEvents } from '@svrooij/sonos';

const env = Object.fromEntries(
    readFileSync(new URL('../../music-assistant-controller/.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const uuid = process.argv[2];
const seconds = Number(process.argv[3] ?? 200);
const i = process.argv.indexOf('--next');
const every = i >= 0 ? Number(process.argv[i + 1]) : 40;
const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);

const manager = new SonosManager();
await manager.InitializeWithDiscovery(10);
const device = manager.Devices.find((d) => d.Uuid === uuid);
if (!device) throw new Error(`no speaker ${uuid} (found: ${manager.Devices.map((d) => `${d.Name} ${d.Uuid}`).join(', ')})`);
console.log(`speaker ${device.Name} ${device.Host}`);

const skips = [];
const seen = (src, title) => {
    console.log(`${rel()}  ${src.padEnd(20)} ${title}`);
    const s = skips.at(-1);
    if (s && title && !s[src]) s[src] = { t: Date.now(), title };
};
device.Events.on(SonosEvents.CurrentTrackMetadata, (track) => seen('sonos upnp', track?.Title));
device.Events.on(SonosEvents.CurrentTransportStateSimple, (state) => console.log(`${rel()}  sonos state          ${state}`));

const ws = new WebSocket(env.MA_URL.replace(/^http/, 'ws') + '/ws');
let id = 1;
const pending = new Map();
const send = (command, args = {}) =>
    new Promise((r) => {
        const m = String(id++);
        pending.set(m, r);
        ws.send(JSON.stringify({ message_id: m, command, args }));
    });
ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.message_id && pending.has(msg.message_id)) {
        pending.get(msg.message_id)(msg);
        pending.delete(msg.message_id);
    } else if (msg.event === 'queue_updated' && msg.data?.queue_id === uuid) seen('ma queue', msg.data.current_item?.media_item?.name ?? msg.data.current_item?.name);
});
await new Promise((r) => ws.addEventListener('open', r));
await send('auth', { token: env.MA_TOKEN });

const timer = setInterval(() => {
    skips.push({ at: Date.now() });
    console.log(`${rel()}  >>> next`);
    void send('player_queues/next', { queue_id: uuid });
}, every * 1000);

setTimeout(async () => {
    clearInterval(timer);
    console.log('\n=== seconds after each skip ===');
    for (const [n, s] of skips.entries()) {
        const fmt = (k) => (s[k] ? `${((s[k].t - s.at) / 1000).toFixed(1)} s (${s[k].title})` : 'not within the window');
        console.log(`#${n + 1}  ma: ${fmt('ma queue')}   sonos: ${fmt('sonos upnp')}`);
    }
    ws.close();
    await manager.CancelSubscription?.();
    process.exit(0);
}, seconds * 1000);
