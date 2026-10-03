// Marketplace images built from the staged simulator scenes (run `npm run showcase` first), as in
// Music Assistant Controller: deep night blue, a glow in SO-C's Sage and the covers' warm colours,
// a thin particle network like the Panorama effect, the deck as the hero, short headlines.
// Writes store-thumbnail, store-showcase-* and store-banner into store/ (the icon stays from
// generate-store-assets.mjs).
//   node tools/generate-store-images.mjs
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const OUT = "store";
const SCENES = "sim-out/showcase";
const SAGE = "#87AE73";
const WARM = "#ff7a59";
fs.mkdirSync(OUT, { recursive: true });

// The lobster wireframe (white on black) → black lines on a transparent ground, for the Sage mark
const lob = await sharp("store/lobster_icon.png").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const ink = Buffer.alloc(lob.info.width * lob.info.height * 4);
for (let i = 0; i < lob.info.width * lob.info.height; i++) {
    ink[i * 4 + 3] = lob.data[i * 4]; // brightness of the line = opacity of black ink
}
const lobsterHref = `data:image/png;base64,${(await sharp(ink, { raw: { width: lob.info.width, height: lob.info.height, channels: 4 } }).png().toBuffer()).toString("base64")}`;

/** Seeded random, so every run draws the same background. */
function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(1664525, s) + 1013904223) >>> 0) / 4294967296);
}

/** Night-blue background with two glows and a sparse particle network. */
function background(w, h, seed = 7) {
    const r = rng(seed);
    const pts = Array.from({ length: Math.round((w * h) / 26000) }, () => ({ x: r() * w, y: r() * h, s: 1.5 + r() * 2.5 }));
    const lines = [];
    for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) {
            const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
            if (d < 150) lines.push(`<line x1="${pts[i].x.toFixed(0)}" y1="${pts[i].y.toFixed(0)}" x2="${pts[j].x.toFixed(0)}" y2="${pts[j].y.toFixed(0)}" stroke="${SAGE}" stroke-opacity="${((1 - d / 150) * 0.22).toFixed(2)}" stroke-width="1.5"/>`);
        }
    return `
<defs>
  <radialGradient id="glowA" cx="0.78" cy="0.35" r="0.55"><stop offset="0" stop-color="${SAGE}" stop-opacity="0.4"/><stop offset="1" stop-color="${SAGE}" stop-opacity="0"/></radialGradient>
  <radialGradient id="glowB" cx="0.15" cy="0.95" r="0.5"><stop offset="0" stop-color="${WARM}" stop-opacity="0.28"/><stop offset="1" stop-color="${WARM}" stop-opacity="0"/></radialGradient>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.65"/></filter>
</defs>
<rect width="${w}" height="${h}" fill="#070b16"/>
<rect width="${w}" height="${h}" fill="url(#glowA)"/><rect width="${w}" height="${h}" fill="url(#glowB)"/>
${lines.join("")}
${pts.map((p) => `<circle cx="${p.x.toFixed(0)}" cy="${p.y.toFixed(0)}" r="${p.s.toFixed(1)}" fill="${SAGE}" opacity="0.5"/>`).join("")}`;
}

/** The lobster mark on a Sage circle. */
function mark(cx, cy, r) {
    const pad = r * 0.22;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SAGE}"/><image href="${lobsterHref}" x="${cx - r + pad}" y="${cy - r + pad}" width="${2 * (r - pad)}" height="${2 * (r - pad)}"/>`;
}

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const FONT = `font-family="Segoe UI, Arial, sans-serif"`;

/** A deck render, framed like a device: rounded dark body with a soft shadow. */
async function device(scene, width) {
    const img = sharp(path.join(SCENES, `${scene}.png`));
    const meta = await img.metadata();
    const h = Math.round((meta.height / meta.width) * width);
    const png = (await img.resize(width, h).png().toBuffer()).toString("base64");
    const pad = Math.round(width * 0.035);
    return { w: width + 2 * pad, h: h + 2 * pad, svg: (x, y) => `<g filter="url(#shadow)"><rect x="${x}" y="${y}" width="${width + 2 * pad}" height="${h + 2 * pad}" rx="${pad * 1.4}" fill="#121521" stroke="#2a2f45" stroke-width="2"/></g><image href="data:image/png;base64,${png}" x="${x + pad}" y="${y + pad}" width="${width}" height="${h}"/>` };
}

async function write(file, w, h, body) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${background(w, h, w + h)}${body}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, file));
    console.log("wrote", path.join(OUT, file));
}

/** Headline block: eyebrow, title lines, subline. */
function copy(x, y, eyebrow, title, sub, size = 64) {
    const lines = title.split("\n");
    return `<text x="${x}" y="${y}" ${FONT} font-size="${Math.round(size * 0.34)}" font-weight="700" letter-spacing="3" fill="${SAGE}">${esc(eyebrow.toUpperCase())}</text>
${lines.map((l, i) => `<text x="${x}" y="${y + size * 1.25 + i * size * 1.1}" ${FONT} font-size="${size}" font-weight="800" fill="#ffffff">${esc(l)}</text>`).join("")}
${sub.split("\n").map((l, i) => `<text x="${x}" y="${y + size * 1.25 + lines.length * size * 1.1 + 24 + i * size * 0.52}" ${FONT} font-size="${Math.round(size * 0.4)}" fill="#b9c2d8">${esc(l)}</text>`).join("")}`;
}

// Thumbnail 1920×960: mark, name, the deck
{
    const d = await device("01-everyday", 940);
    await write("store-thumbnail-1920x960.png", 1920, 960, `
${mark(190, 200, 70)}
${copy(120, 360, "SONOS Controller", "Your Sonos.\nOn every key.", "Playback, volume, favorites and groups —\nlocal, no cloud, no account.", 76)}
${d.svg(1920 - d.w - 90, (960 - d.h) / 2)}`);
}

// Showcases 1920×960
const showcases = [
    ["store-showcase-track.png", "01-everyday", "Every day", "Cover, queue,\nfavorites.", "Track, volume, the queue and your favorites\non the dials — with a Panorama behind them."],
    ["store-showcase-favorites.png", "02-lists", "Browse", "Scroll it.\nPlay it.", "Favorites and the queue as smooth lists,\nthe playing one in green. Push to play."],
    ["store-showcase-panorama.png", "03-panorama", "Panorama", "One scene.\nFour dials.", "Effects span the whole row of dials,\nalso other plugins'. Turn to tune them."],
    ["store-showcase-keys.png", "04-volume-looks", "Your look", "Pie, ring\nor horseshoe.", "Volume the way you like it,\nfor one room or the whole group."],
];
for (const [file, scene, eyebrow, title, sub] of showcases) {
    const d = await device(scene, 940);
    await write(file, 1920, 960, `${copy(110, 290, eyebrow, title, sub, 72)}${d.svg(1920 - d.w - 70, (960 - d.h) / 2)}`);
}

// Banner 1280×640
{
    const d = await device("03-panorama", 640);
    await write("store-banner.png", 1280, 640, `${mark(120, 130, 46)}${copy(80, 250, "SONOS Controller", "Your Sonos.\nOn every key.", "For Stream Deck and Stream Deck +", 54)}${d.svg(1280 - d.w - 50, (640 - d.h) / 2)}`);
}
