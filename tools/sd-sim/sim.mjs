// Stream Deck simulator (from Music Assistant Controller): runs the real plugin (bin/plugin.js)
// against a fake Stream Deck app.
//
// It speaks the Stream Deck plugin protocol over WebSocket: sends willAppear / keyDown / dialRotate /
// …, and records what the plugin sends back (setImage, setTitle, setFeedback, showAlert, …).
// Images are written as PNG (see sim-render.mjs) so they can be looked at; `snapshot()` also
// renders the whole virtual deck into one image.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const { WebSocketServer } = require("ws");

import { renderDeck } from "./sim-render.mjs";

const PLUGIN_UUID = "de.boriskemper.sonos-controller";
const SD_PLUGIN = path.join(root, `${PLUGIN_UUID}.sdPlugin`);
const DEVICE = { id: "sim-device", name: "Simulated Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 };

/** Read settings from the repo's .env (gitignored), if there is one. */
export function readEnv() {
    const file = path.join(root, ".env");
    if (!fs.existsSync(file)) return {};
    return Object.fromEntries(
        fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
}

export async function startSim({ globalSettings = {}, language = "de", verbose = false } = {}) {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss.once("listening", r));
    const port = wss.address().port;

    const state = {
        globalSettings,
        /** context → { action, settings, coordinates, controller, image, title, feedback, layout, alerts, oks } */
        slots: new Map(),
        log: [],
        piMessages: [],
    };
    const waiters = new Set();
    const piListeners = new Set();
    const notify = () => {
        for (const w of [...waiters]) {
            if (!w.check()) continue;
            waiters.delete(w);
            w.resolve();
        }
    };

    let socket;
    const connected = new Promise((resolve) => {
        wss.on("connection", (ws) => {
            socket = ws;
            ws.on("message", (raw) => {
                const msg = JSON.parse(String(raw));
                if (msg.event === "registerPlugin") return resolve();
                handle(msg);
            });
        });
    });

    const info = {
        application: { font: "Segoe UI", language, platform: "windows", platformVersion: "10.0.26200", version: "7.0.0.0" },
        colors: {},
        devicePixelRatio: 2,
        devices: [DEVICE],
        plugin: { uuid: PLUGIN_UUID, version: "0.1.0" },
    };
    const child = spawn(process.execPath, ["bin/plugin.js", "-port", String(port), "-pluginUUID", PLUGIN_UUID, "-registerEvent", "registerPlugin", "-info", JSON.stringify(info)], {
        cwd: SD_PLUGIN,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => verbose && process.stdout.write(`[plugin] ${d}`));
    child.stderr.on("data", (d) => process.stderr.write(`[plugin:err] ${d}`));

    const send = (msg) => socket.send(JSON.stringify(msg));

    function handle(msg) {
        state.log.push(msg);
        const slot = msg.context ? state.slots.get(msg.context) : undefined;
        switch (msg.event) {
            case "getGlobalSettings":
                send({ event: "didReceiveGlobalSettings", payload: { settings: state.globalSettings } });
                break;
            case "setGlobalSettings":
                state.globalSettings = msg.payload;
                break;
            case "getSettings":
                if (slot) send({ event: "didReceiveSettings", action: slot.action, context: msg.context, device: DEVICE.id, payload: payload(slot) });
                break;
            case "setSettings":
                if (slot) slot.settings = msg.payload;
                break;
            case "setImage":
                if (slot) slot.image = msg.payload?.image;
                break;
            case "setTitle":
                if (slot) slot.title = msg.payload?.title ?? "";
                break;
            case "setState":
                if (slot) slot.state = msg.payload?.state;
                break;
            case "setFeedback":
                if (slot) slot.feedback = { ...slot.feedback, ...msg.payload };
                break;
            case "setFeedbackLayout":
                if (slot) slot.layout = msg.payload?.layout;
                break;
            case "showAlert":
                if (slot) slot.alerts++;
                break;
            case "showOk":
                if (slot) slot.oks++;
                break;
            case "sendToPropertyInspector":
                state.piMessages.push(msg.payload);
                for (const fn of piListeners) fn(msg.payload);
                break;
            case "logMessage":
                if (verbose) console.log("[plugin log]", msg.payload?.message);
                break;
        }
        notify();
    }

    function payload(slot, extra = {}) {
        return { settings: slot.settings, coordinates: slot.coordinates, controller: slot.controller, isInMultiAction: false, state: slot.state ?? 0, ...extra };
    }

    await connected;

    const sim = {
        state,
        info,

        /** Place an action on the deck. `controller`: "Keypad" (default) or "Encoder". Returns its context. */
        add(actionSuffix, settings = {}, { column = 0, row = 0, controller = "Keypad" } = {}) {
            const context = `ctx-${controller[0]}-${column}-${row}`;
            const action = `${PLUGIN_UUID}.${actionSuffix}`;
            const slot = { action, settings, coordinates: { column, row }, controller, alerts: 0, oks: 0, feedback: {} };
            state.slots.set(context, slot);
            send({ event: "willAppear", action, context, device: DEVICE.id, payload: payload(slot) });
            return context;
        },
        remove(context) {
            const slot = state.slots.get(context);
            send({ event: "willDisappear", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
            state.slots.delete(context);
        },
        /** Change an action's settings as if the user edited them in the PI. */
        setSettings(context, settings) {
            const slot = state.slots.get(context);
            slot.settings = settings;
            send({ event: "didReceiveSettings", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
        },
        /** Change global settings as if the user edited them in a PI. */
        setGlobalSettings(settings) {
            state.globalSettings = settings;
            send({ event: "didReceiveGlobalSettings", payload: { settings } });
        },
        press(context) {
            const slot = state.slots.get(context);
            send({ event: "keyDown", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
            send({ event: "keyUp", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
        },
        rotate(context, ticks) {
            const slot = state.slots.get(context);
            send({ event: "dialRotate", action: slot.action, context, device: DEVICE.id, payload: payload(slot, { ticks, pressed: false }) });
        },
        dialPress(context) {
            const slot = state.slots.get(context);
            send({ event: "dialDown", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
            send({ event: "dialUp", action: slot.action, context, device: DEVICE.id, payload: payload(slot) });
        },
        touch(context, hold = false) {
            const slot = state.slots.get(context);
            send({ event: "touchTap", action: slot.action, context, device: DEVICE.id, payload: payload(slot, { hold, tapPos: [100, 50] }) });
        },
        /** Simulate opening the PI of an action, then sending it a message. */
        piOpen(context) {
            const slot = state.slots.get(context);
            send({ event: "propertyInspectorDidAppear", action: slot.action, context, device: DEVICE.id });
        },
        piSend(context, payloadToPlugin) {
            const slot = state.slots.get(context);
            send({ event: "sendToPlugin", action: slot.action, context, payload: payloadToPlugin });
        },

        /** Messages the plugin sends to the (open) property inspector. */
        onPiMessage(fn) {
            piListeners.add(fn);
            return () => piListeners.delete(fn);
        },

        /** Resolve when `check()` returns true (re-evaluated on every plugin message), or reject after `timeoutMs`. */
        waitFor(check, timeoutMs = 10_000, label = "condition") {
            if (check()) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const w = { check, resolve };
                waiters.add(w);
                setTimeout(() => {
                    if (waiters.delete(w)) reject(new Error(`timeout waiting for ${label}`));
                }, timeoutMs);
            });
        },
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

        /** Render every slot plus the deck overview into `dir`. Returns the deck image path. */
        /** Writes into `<dir>/<scenario>/` (the running script's name), so scenarios don't mix. */
        snapshot(dir, name = "deck") {
            const scenario = path.basename(process.argv[1] ?? "sim", ".mjs");
            return renderDeck(state.slots, path.basename(dir) === scenario ? dir : path.join(dir, scenario), name);
        },

        async stop() {
            child.kill();
            wss.close();
        },
    };
    return sim;
}
