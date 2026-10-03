// Rendering for the Stream Deck simulator: turns what the plugin sent (key images, titles,
// touch-strip feedback) into PNG files, one per slot plus a whole-deck overview.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(path.join(root, "package.json"));
const sharp = require("sharp");

const KEY = 144;

/** Write the deck overview (`<name>.png`) into `dir` and one PNG per slot into `dir/parts`. Returns the overview path. */
export async function renderDeck(slots, dir, name = "deck") {
    fs.mkdirSync(path.join(dir, "parts"), { recursive: true });
    const layers = [];
    // Stream Deck +: keys sit centered over the four dials, like on the device
    const plus = [...slots.values()].some((s) => s.controller === "Encoder");
    for (const [context, slot] of slots) {
        const png = await renderSlot(slot);
        fs.writeFileSync(path.join(dir, "parts", `${name}-${context}.png`), png);
        const { column, row } = slot.coordinates;
        const top = slot.controller === "Encoder" ? 2 * (KEY + 24) + 24 : row * (KEY + 24) + 12;
        const left = slot.controller === "Encoder" ? column * 200 + 12 : plus ? column * 200 + 12 + (200 - KEY) / 2 : column * (KEY + 24) + 12;
        layers.push({ input: png, top, left });
    }
    const encoders = [...slots.values()].some((s) => s.controller === "Encoder");
    const deckPath = path.join(dir, `${name}.png`);
    const width = Math.max(4 * (KEY + 24) + 12, encoders ? 4 * 200 + 24 : 0);
    await sharp({ create: { width, height: encoders ? 2 * (KEY + 24) + 24 + 100 + 24 : 2 * (KEY + 24) + 12, channels: 4, background: "#0b0b0c" } })
        .composite(layers)
        .png()
        .toFile(deckPath);
    return deckPath;
}

/** Key image (with title overlay) or touch-strip segment for one slot, as PNG. */
async function renderSlot(slot) {
    if (slot.controller === "Encoder") return renderEncoder(slot);
    const base = slot.image ? await imageToPng(slot.image, KEY, KEY) : await sharp({ create: { width: KEY, height: KEY, channels: 4, background: "#222" } }).png().toBuffer();
    if (!slot.title) return base;
    // Stream Deck draws titles at the bottom by default, white with a dark outline.
    const lines = String(slot.title).split("\n");
    const text = lines
        .map((l, i) => `<text x="72" y="${KEY - 12 - (lines.length - 1 - i) * 22}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="20" font-weight="600" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${escapeXml(l)}</text>`)
        .join("");
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${KEY}" height="${KEY}">${text}</svg>`);
    return sharp(base).composite([{ input: overlay }]).png().toBuffer();
}

async function renderEncoder(slot) {
    // 200×100 touch-strip segment. Shows a full-canvas pixmap if present, else the feedback values as text.
    const W = 200;
    const H = 100;
    const fb = slot.feedback ?? {};
    const pixmapKey = Object.keys(fb).find((k) => typeof fb[k] === "string" && fb[k].startsWith("data:image"));
    const nested = Object.values(fb).find((v) => v && typeof v === "object" && typeof v.value === "string" && v.value.startsWith("data:image"));
    const img = pixmapKey ? fb[pixmapKey] : nested?.value;
    if (img) return imageToPng(img, W, H);
    const text = Object.entries(fb)
        .map(([k, v], i) => `<text x="8" y="${20 + i * 18}" font-family="Segoe UI, sans-serif" font-size="13" fill="#ddd">${escapeXml(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)}</text>`)
        .join("");
    return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#111"/>${text}</svg>`)).png().toBuffer();
}

async function imageToPng(dataUri, w, h) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUri);
    if (!m) return sharp({ create: { width: w, height: h, channels: 4, background: "#400" } }).png().toBuffer();
    const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    return sharp(buf, { density: 144 }).resize(w, h).png().toBuffer();
}

function escapeXml(s) {
    return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
