// Preview the property inspectors in a normal browser, without Stream Deck.
// Serves the plugin's ui/ folder and fakes the Stream Deck socket and the plugin's answers.
//
//   npm run pi:preview  → http://localhost:5299/volume-dial.html?lang=de
//   ?lang=en|de|es · ?window (the settings window) · ?click=<css selector> (e.g. open a dropdown)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";

const HTTP_PORT = Number(process.env.PORT ?? 5299);
const WS_PORT = HTTP_PORT + 1;
const UUID = "de.boriskemper.sonos-controller";
const UI = path.resolve(`${UUID}.sdPlugin/ui`);
const { listEffects } = await import("@rocklobster42195/streamdeck-kit");

/** Invented answers for the lists the PI asks the plugin for (<pi-select source="…">). */
const rooms = ["Living Room", "Kitchen", "Office", "Bedroom", "Terrace"];
const optionLists = {
    "sonos-devices": () => rooms.map((name, i) => ({ value: `192.0.2.${10 + i}`, label: name })),
    "sonos-groups": () => [{ value: "192.0.2.10", label: "Living Room + 2" }, { value: "192.0.2.13", label: "Bedroom" }],
};

const wss = new WebSocketServer({ port: WS_PORT });
wss.on("connection", (ws) => {
    const reply = (msg) => ws.send(JSON.stringify(msg));
    ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        switch (msg.event) {
            case "getGlobalSettings":
                reply({ event: "didReceiveGlobalSettings", payload: { settings: {} } });
                break;
            case "setSettings":
                console.log("setSettings", msg.payload);
                break;
            case "setGlobalSettings":
                console.log("setGlobalSettings", msg.payload);
                break;
            case "sendToPlugin":
                if (msg.payload?.event === "pi-ready") {
                    reply({ event: "sendToPropertyInspector", payload: { event: "effects", effects: listEffects() } });
                } else if (msg.payload?.event === "options") {
                    const { requestId, source, params } = msg.payload;
                    const items = optionLists[source]?.(params ?? {}) ?? [];
                    reply({ event: "sendToPropertyInspector", payload: { event: "options-result", requestId, source, items } });
                } else console.log("sendToPlugin", msg.payload);
                break;
            case "openUrl":
                console.log("openUrl", msg.payload.url);
                break;
        }
    });
});

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${HTTP_PORT}`);
    const file = path.join(UI, decodeURIComponent(u.pathname === "/" ? "/volume-dial.html" : u.pathname));
    if (!file.startsWith(UI) || !fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
    }
    let body = fs.readFileSync(file);
    if (file.endsWith(".html")) {
        const lang = u.searchParams.get("lang") ?? "de";
        const action = path.basename(file, ".html");
        const info = { application: { language: lang, platform: "windows", version: "7.0" }, plugin: { uuid: UUID, version: "0.5.0" } };
        const actionInfo = { action: `${UUID}.${action}`, context: "ctx", device: "dev", payload: { settings: { deviceIp: "192.0.2.10" } } };
        const click = u.searchParams.get("click");
        const boot = `<script>window.addEventListener("load",()=>{connectElgatoStreamDeckSocket(${WS_PORT},"pi","registerPropertyInspector",${JSON.stringify(JSON.stringify(info))},${JSON.stringify(JSON.stringify(actionInfo))});${click ? `let n=0;const tryClick=()=>{const el=!document.body.hidden&&document.querySelector(${JSON.stringify(click)});if(el)el.click();else if(n++<50)setTimeout(tryClick,100);};tryClick();` : ""}});</script><style>body{width:360px}</style>`;
        body = Buffer.from(String(body).replace("</body>", `${boot}</body>`));
    }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" }).end(body);
}).listen(HTTP_PORT, () => console.log(`PI preview: http://localhost:${HTTP_PORT}/volume-dial.html?lang=de`));
