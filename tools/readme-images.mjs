// README pictures from the staged simulator scenes (run `npm run showcase` first): dial rows,
// single dial strips and keys, cut from sim-out/showcase/parts into assets/readme/.
//   node tools/readme-images.mjs
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const PARTS = "sim-out/showcase/parts";
const OUT = "assets/readme";
fs.mkdirSync(OUT, { recursive: true });

const part = (scene, kind, col, row = 0) => path.join(PARTS, `${scene}-ctx-${kind}-${col}-${row}.png`);
const SCALE = 2;

/** Dial strips side by side (with the small gap of a real Stream Deck +), scaled up. */
async function row(file, scene, cols) {
    const gap = 4;
    const w = cols.length * 200 + (cols.length - 1) * gap;
    const composite = cols.map((c, i) => ({ input: part(scene, "E", c), left: i * (200 + gap), top: 0 }));
    const buf = await sharp({ create: { width: w, height: 100, channels: 4, background: "#000000" } }).composite(composite).png().toBuffer();
    await sharp(buf).resize(w * SCALE, 100 * SCALE, { kernel: "lanczos3" }).png().toFile(path.join(OUT, file));
    console.log("wrote", path.join(OUT, file));
}

async function single(file, input, w, h) {
    await sharp(input).resize(w * SCALE, h * SCALE, { kernel: "lanczos3" }).png().toFile(path.join(OUT, file));
    console.log("wrote", path.join(OUT, file));
}

await row("dials-everyday.png", "01-everyday", [0, 1, 2, 3]);
await row("dials-panorama.png", "03-panorama", [0, 1, 2, 3]);
await row("dials-volume-looks.png", "04-volume-looks", [0, 1, 2, 3]);
await single("dial-queue.png", part("02-lists", "E", 2), 200, 100);
await single("dial-favorites-list.png", part("02-lists", "E", 3), 200, 100);
await single("dial-favorites-idle.png", part("01-everyday", "E", 3), 200, 100);
await single("dial-track.png", part("01-everyday", "E", 0), 200, 100);
await single("key-play-pause.png", part("01-everyday", "K", 1, 0), 144, 144);
await single("key-play-favorite.png", part("02-lists", "K", 3, 1), 144, 144);
