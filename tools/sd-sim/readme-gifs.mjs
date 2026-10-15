// Animated README pictures from the simulator: the real plugin against the stand-in Sonos system
// (fake-sonos.mjs, nothing is played anywhere), frames sampled while a dial turns or a key is tapped.
//   node tools/sd-sim/readme-gifs.mjs [scene]        scenes: list-scroll (the Queue dial), multi-tap (the Play/Pause key)
// Writes assets/readme/<scene>.gif.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import GIFEncoder from "gif-encoder-2";
import { startFakeSonos } from "./fake-sonos.mjs";
import { startSim } from "./sim.mjs";

// The plugin's UPnP event listener must not collide with a running SO-C
process.env.SONOS_LISTENER_PORT ??= "6351";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sharp = createRequire(path.join(root, "package.json"))("sharp");
const OUT = path.join(root, "assets", "readme");
fs.mkdirSync(OUT, { recursive: true });

const LIVING = "127.0.0.2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The picture a slot shows now (key image or strip pixmap) as a PNG buffer at w × h. */
async function pictureOf(slot, w, h) {
    const fb = slot.feedback ?? {};
    const key = Object.keys(fb).find((k) => typeof fb[k] === "string" && fb[k].startsWith("data:image"));
    const nested = Object.values(fb).find((v) => v && typeof v === "object" && typeof v.value === "string" && v.value.startsWith("data:image"));
    const uri = slot.controller === "Encoder" ? (key ? fb[key] : nested?.value) : slot.image;
    const m = uri && /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
    if (!m) return sharp({ create: { width: w, height: h, channels: 4, background: "#111" } }).png().toBuffer();
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    return sharp(buf, { density: 144 }).resize(w, h).png().toBuffer();
}

/** The picture string a slot shows now (key image or strip pixmap), to see when it changes. */
function uriOf(slot) {
    const fb = slot.feedback ?? {};
    const key = Object.keys(fb).find((k) => typeof fb[k] === "string" && fb[k].startsWith("data:image"));
    const nested = Object.values(fb).find((v) => v && typeof v === "object" && typeof v.value === "string" && v.value.startsWith("data:image"));
    return slot.controller === "Encoder" ? (key ? fb[key] : nested?.value) : slot.image;
}

/**
 * Records `slots` side by side while `during()` runs: one frame for every picture the plugin sends
 * (polled every few ms), each kept as long as it was on screen, so a gliding list is as smooth as
 * on the device. Then writes the GIF.
 */
async function record(file, { slots, size, gap = 4, scale = 2, settle = 0, during }) {
    const [w, h] = size;
    const totalW = slots.length * w + (slots.length - 1) * gap;
    const frames = [];
    let running = true;
    let last = "";
    const sampler = (async () => {
        while (running) {
            const now = slots.map(uriOf).join("|");
            if (now !== last) {
                last = now;
                const at = Date.now();
                const parts = await Promise.all(slots.map((s) => pictureOf(s, w, h)));
                const composite = parts.map((input, i) => ({ input, left: i * (w + gap), top: 0 }));
                const png = await sharp({ create: { width: totalW, height: h, channels: 4, background: "#000000" } }).composite(composite).png().toBuffer();
                const raw = await sharp(png).resize(totalW * scale, h * scale, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer();
                frames.push({ raw, at });
            } else await sleep(5);
        }
    })();
    await sleep(settle);
    await during();
    running = false;
    await sampler;
    const enc = new GIFEncoder(totalW * scale, h * scale, "neuquant", true, frames.length);
    enc.setRepeat(0);
    enc.setQuality(10);
    enc.start();
    frames.forEach((f, i) => {
        enc.setDelay(Math.max(20, Math.min(1500, (frames[i + 1]?.at ?? f.at + 500) - f.at)));
        enc.addFrame(new Uint8ClampedArray(f.raw));
    });
    enc.finish();
    const data = enc.out.getData();
    fs.writeFileSync(file, data);
    console.log(`wrote ${path.relative(root, file)} (${frames.length} frames, ${(data.length / 1024).toFixed(0)} KB)`);
}

const scenes = {
    // The Queue dial turned a few clicks: the list glides one entry per click
    async "list-scroll"(sim) {
        const queue = sim.add("queue-dial", { deviceIp: LIVING, panoramaMember: false }, { column: 0, controller: "Encoder" });
        await sim.sleep(9000);
        await record(path.join(OUT, "list-scroll.gif"), {
            slots: [sim.state.slots.get(queue)],
            size: [200, 100],
            settle: 500,
            during: async () => {
                for (const ticks of [1, 1, 1, -1, -1, -1]) {
                    sim.rotate(queue, ticks);
                    await sleep(900);
                }
                await sleep(300);
            },
        });
    },
    // The Play/Pause key with double and triple tap on: a double tap skips forward, a triple back
    async "multi-tap"(sim) {
        const key = sim.add("play-pause-key", { deviceIp: LIVING, multiTap: true, showTrackTitle: false }, { column: 0, row: 0 });
        await sim.sleep(9000);
        await record(path.join(OUT, "multi-tap.gif"), {
            slots: [sim.state.slots.get(key)],
            size: [144, 144],
            scale: 1,
            settle: 600,
            during: async () => {
                for (const taps of [2, 3]) {
                    for (let i = 0; i < taps; i++) {
                        sim.press(key);
                        await sleep(110);
                    }
                    await sleep(1700);
                }
            },
        });
    },
};

const sonos = await startFakeSonos();
try {
    const only = process.argv[2];
    for (const [name, run] of Object.entries(scenes)) {
        if (only && name !== only) continue;
        const sim = await startSim({ language: "en", globalSettings: { lastKnownDeviceIp: sonos.seedIp, householdId: sonos.household } });
        try {
            await run(sim);
        } finally {
            await sim.stop();
        }
    }
} finally {
    await sonos.stop();
}
process.exit(0);
