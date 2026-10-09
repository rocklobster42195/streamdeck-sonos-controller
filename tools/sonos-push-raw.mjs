// Every message the speaker pushes on its local API, with the time since start. Read-only.
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node tools/sonos-push-raw.mjs <speaker ip> [seconds=60]
import WebSocket from 'ws';
const ip = process.argv[2];
const API_KEY = '123e4567-e89b-12d3-a456-426655440000';
const info = await (await fetch(`https://${ip}:1443/api/v1/players/local/info`, { headers: { 'X-Sonos-Api-Key': API_KEY } })).json();
const t0 = Date.now();
const ws = new WebSocket(`wss://${ip}:1443/websocket/api`, 'v1.api.smartspeaker.audio', { headers: { 'X-Sonos-Api-Key': API_KEY }, rejectUnauthorized: false });
ws.on('open', () => {
    for (const namespace of ['playback:1', 'groupVolume:1']) ws.send(JSON.stringify([{ namespace, command: 'subscribe', householdId: info.householdId, groupId: info.groupId, cmdId: namespace }, {}]));
});
ws.on('message', (raw) => {
    const [head, body] = JSON.parse(String(raw));
    if (head.response) return;
    console.log(`${((Date.now() - t0) / 1000).toFixed(2).padStart(7)}  ${head.type} ${body?.playbackState ?? ''} ${body?.volume ?? ''}`);
});
setTimeout(() => process.exit(0), Number(process.argv[3] ?? 60) * 1000);
