// Local dev tool for effect authors (see CONTRIBUTING_EFFECTS.md): renders any registered
// Panorama Effect live in a browser tab, simulating 1-5 adjacent displays, without needing a
// physical Stream Deck+. Also exports a 10s animated GIF for use in the README.
//
// Run with `npm run effects:preview` (builds this file via rollup.preview.config.mjs, then
// starts the server). Never shipped in the plugin bundle — dev-only.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import GIFEncoder from "gif-encoder-2";
import { effectRegistry } from "../effects/registry.generated";
import type { EffectInstance } from "../effects/types";

const PORT = parseInt(process.env.PORT ?? "4173", 10);
const DISPLAY_W = 200;
const DISPLAY_H = 100;
const TICK_INTERVAL = 50;
const MAX_CATCHUP_TICKS = 20; // avoid a huge burst if the browser tab was backgrounded

interface Session {
    instance: EffectInstance<any>;
    numDisplays: number;
    lastTickAt: number;
}

const sessions = new Map<string, Session>();

function getSession(effectId: string, numDisplays: number): Session | null {
    const def = effectRegistry.get(effectId);
    if (!def) return null;
    const key = `${effectId}:${numDisplays}`;
    let session = sessions.get(key);
    if (!session) {
        const instance = def.createInstance();
        instance.initPanorama({ width: numDisplays * DISPLAY_W, height: DISPLAY_H, settings: def.defaultSettings });
        session = { instance, numDisplays, lastTickAt: Date.now() };
        sessions.set(key, session);
    }
    return session;
}

function tickSession(session: Session): void {
    const now = Date.now();
    let ticks = Math.floor((now - session.lastTickAt) / TICK_INTERVAL);
    if (ticks <= 0) return;
    ticks = Math.min(ticks, MAX_CATCHUP_TICKS);
    for (let i = 0; i < ticks; i++) session.instance.tickPanorama(TICK_INTERVAL);
    session.lastTickAt = now;
}

function renderPanoramaSvg(instance: EffectInstance<any>, numDisplays: number): string {
    const width = numDisplays * DISPLAY_W;
    let fragments = "";
    for (let i = 0; i < numDisplays; i++) {
        fragments += `<g transform="translate(${i * DISPLAY_W},0)">${instance.renderSlice(i * DISPLAY_W, DISPLAY_W, DISPLAY_H)}</g>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${DISPLAY_H}" viewBox="0 0 ${width} ${DISPLAY_H}"><rect width="${width}" height="${DISPLAY_H}" fill="#000"/>${fragments}</svg>`;
}

async function exportGif(effectId: string, numDisplays: number): Promise<Buffer> {
    const def = effectRegistry.get(effectId);
    if (!def) throw new Error(`Unknown effect: ${effectId}`);
    const instance = def.createInstance();
    const width = numDisplays * DISPLAY_W;
    instance.initPanorama({ width, height: DISPLAY_H, settings: def.defaultSettings });

    const totalFrames = Math.round(10000 / TICK_INTERVAL); // 10 seconds
    const fadeFrames = Math.round(400 / TICK_INTERVAL); // 400ms fade in/out — smooths the loop point
    const encoder = new GIFEncoder(width, DISPLAY_H, "neuquant", true, totalFrames);
    encoder.setDelay(TICK_INTERVAL);
    encoder.setRepeat(0);
    encoder.setQuality(10);
    encoder.start();

    for (let frame = 0; frame < totalFrames; frame++) {
        instance.tickPanorama(TICK_INTERVAL);
        const svg = renderPanoramaSvg(instance, numDisplays);
        const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

        // Fade to black at the start/end so a looped GIF doesn't jump-cut.
        const fade = Math.min(1, frame / fadeFrames, (totalFrames - 1 - frame) / fadeFrames);
        if (fade < 1) {
            for (let i = 0; i < data.length; i += 4) {
                data[i] = Math.round(data[i] * fade);
                data[i + 1] = Math.round(data[i + 1] * fade);
                data[i + 2] = Math.round(data[i + 2] * fade);
            }
        }

        encoder.addFrame(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
    }

    encoder.finish();
    return encoder.out.getData();
}

const HTML_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Panorama Effects Preview</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1e1e1e; color: #eee; padding: 24px; }
  select, input, button { font-size: 14px; padding: 6px 10px; margin-right: 8px; }
  #view { display: block; margin-top: 16px; border: 1px solid #444; image-rendering: pixelated; }
  #status { margin-top: 8px; color: #9c9; font-size: 13px; min-height: 1.2em; }
</style></head>
<body>
  <h2>Panorama Effects Preview</h2>
  <div>
    <label>Effect: <select id="effect"></select></label>
    <label>Displays: <input type="number" id="displays" min="1" max="5" value="1" style="width:4em"></label>
    <button id="rotateMinus">Rotate -1</button>
    <button id="rotatePlus">Rotate +1</button>
    <button id="press">Press</button>
    <button id="export">Export 10s GIF</button>
  </div>
  <img id="view" width="600" height="100">
  <div id="status"></div>
<script>
  const effectSelect = document.getElementById('effect');
  const displaysInput = document.getElementById('displays');
  const view = document.getElementById('view');
  const status = document.getElementById('status');

  function params() {
    return 'effect=' + encodeURIComponent(effectSelect.value) + '&displays=' + encodeURIComponent(displaysInput.value);
  }

  async function loadEffects() {
    const res = await fetch('/api/effects');
    const { effects } = await res.json();
    effectSelect.innerHTML = effects.map(e => '<option value="' + e.id + '">' + e.displayName + '</option>').join('');
  }

  function refreshFrame() {
    view.width = Number(displaysInput.value) * 200;
    view.src = '/api/frame?' + params() + '&t=' + Date.now();
  }
  setInterval(refreshFrame, 50);

  document.getElementById('rotateMinus').onclick = () => fetch('/api/interact?' + params() + '&action=rotate&ticks=-1');
  document.getElementById('rotatePlus').onclick = () => fetch('/api/interact?' + params() + '&action=rotate&ticks=1');
  document.getElementById('press').onclick = () => fetch('/api/interact?' + params() + '&action=press');

  document.getElementById('export').onclick = async () => {
    status.textContent = 'Rendering 10s GIF...';
    const res = await fetch('/api/export-gif?' + params());
    if (!res.ok) { status.textContent = 'Export failed: ' + await res.text(); return; }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'preview-' + effectSelect.value + '.gif';
    a.click();
    status.textContent = 'Saved to assets/preview-' + effectSelect.value + '.gif and downloaded.';
  };

  loadEffects();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    const q = parsed.searchParams;

    if (parsed.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(HTML_PAGE);
        return;
    }

    if (parsed.pathname === "/api/effects") {
        const effects = [...effectRegistry.values()].map((d) => ({ id: d.id, displayName: d.displayName }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ effects }));
        return;
    }

    const effectId = q.get("effect") ?? "";
    const numDisplays = Math.max(1, Math.min(5, parseInt(q.get("displays") ?? "1", 10) || 1));

    if (parsed.pathname === "/api/frame") {
        const session = getSession(effectId, numDisplays);
        if (!session) { res.writeHead(404); res.end("Unknown effect"); return; }
        tickSession(session);
        res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        res.end(renderPanoramaSvg(session.instance, numDisplays));
        return;
    }

    if (parsed.pathname === "/api/interact") {
        const session = getSession(effectId, numDisplays);
        if (!session) { res.writeHead(404); res.end("Unknown effect"); return; }
        const action = q.get("action");
        if (action === "rotate") session.instance.onRotate?.(parseInt(q.get("ticks") ?? "1", 10));
        if (action === "press") session.instance.onPress?.();
        res.writeHead(204);
        res.end();
        return;
    }

    if (parsed.pathname === "/api/export-gif") {
        exportGif(effectId, numDisplays).then((gif) => {
            const outDir = path.resolve("assets");
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `preview-${effectId}.gif`);
            fs.writeFileSync(outFile, new Uint8Array(gif));
            console.log(`Saved ${outFile}`);
            res.writeHead(200, {
                "Content-Type": "image/gif",
                "Content-Disposition": `attachment; filename="preview-${effectId}.gif"`,
            });
            res.end(gif);
        }).catch((e) => {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(String(e?.message ?? e));
        });
        return;
    }

    res.writeHead(404);
    res.end("Not found");
});

server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
        console.error(
            `Port ${PORT} is already in use (another effects:preview instance running? a Vite ` +
            `dev server? Vite's own "preview" command also defaults to 4173). Stop whatever is ` +
            `using it, or set PORT=<other port> npm run effects:preview.`
        );
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, () => {
    console.log(`Panorama Effects preview: http://localhost:${PORT}`);
});
