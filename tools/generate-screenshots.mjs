/**
 * Generates representative PNG screenshots of all plugin actions.
 * Output: docs/screenshots/  (3× scale for dials, 4× for keys)
 *
 * Run: node tools/generate-screenshots.mjs
 */

import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    mdiVolumeOff, mdiVolumeHigh, mdiVolumePlus, mdiVolumeMinus, mdiTuneVertical,
    mdiSkipNext, mdiSkipPrevious, mdiShuffle, mdiRepeat,
    mdiPlayCircle, mdiPauseCircle,
    mdiMusicCircle, mdiHeartCircle, mdiCreation, mdiKnob, mdiPlaylistPlay, mdiStarCircle,
} from '@mdi/js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'assets', 'screenshots');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── Helpers ────────────────────────────────────────────────────────────────

async function savePng(svg, filename, scale = 1) {
    const buf = Buffer.from(svg);
    await sharp(buf, { density: 96 })
        .resize({ width: Math.round(getW(svg) * scale), kernel: 'lanczos3' })
        .png()
        .toFile(path.join(OUT, filename));
    console.log(`  ✓ ${filename}`);
}

function getW(svg) {
    const m = svg.match(/width="(\d+)"/);
    return m ? +m[1] : 200;
}

function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pie arc from 12 o'clock clockwise
function piePath(cx, cy, r, pct) {
    if (pct <= 0) return '';
    if (pct >= 99.9) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#CCCCCC"/>`;
    const a = (pct / 100) * 360;
    const rad = (a - 90) * Math.PI / 180;
    const x = cx + r * Math.cos(rad);
    const y = cy + r * Math.sin(rad);
    const large = a > 180 ? 1 : 0;
    return `<path d="M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${large} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z" fill="#CCCCCC"/>`;
}

// Static particle network
function particles(w, h, count, seed = 0) {
    const pts = [];
    let s = seed + 1;
    function rnd() { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; }
    for (let i = 0; i < count; i++) pts.push({ x: rnd() * w, y: rnd() * h, r: 1.5 + rnd() * 1.5 });
    const lines = [];
    const circles = [];
    for (let i = 0; i < pts.length; i++) {
        circles.push(`<circle cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="${pts[i].r.toFixed(1)}" fill="#CCCCCC" opacity="0.85"/>`);
        for (let j = i + 1; j < pts.length; j++) {
            const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < 50) lines.push(`<line x1="${pts[i].x.toFixed(1)}" y1="${pts[i].y.toFixed(1)}" x2="${pts[j].x.toFixed(1)}" y2="${pts[j].y.toFixed(1)}" stroke="#CCCCCC" stroke-width="0.6" opacity="${(1 - d / 50).toFixed(2)}"/>`);
        }
    }
    return [...lines, ...circles].join('');
}

// EQ bars (10 bars)
function eqBars(x0, y0, color) {
    const heights = [14, 20, 10, 24, 16, 22, 8, 18, 12, 20];
    return heights.map((h, i) =>
        `<rect x="${x0 + i * 9}" y="${y0 - h}" width="7" height="${h}" fill="${color}" opacity="0.8" rx="1"/>`
    ).join('');
}

// Cover art placeholder (gradient rectangle)
function coverPlaceholder(x, y, w, h, c1, c2, rx = 6) {
    return `<defs>
        <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${c1}"/>
            <stop offset="100%" stop-color="${c2}"/>
        </linearGradient>
        <clipPath id="cc"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/></clipPath>
    </defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="url(#cg)" clip-path="url(#cc)"/>
    <text x="${x + w / 2}" y="${y + h / 2 + 4}" fill="rgba(255,255,255,0.3)" font-size="18" text-anchor="middle" font-family="Arial">♪</text>`;
}

// MDI icon at position
function mdiIcon(d, x, y, size, color = '#CCCCCC') {
    const scale = size / 24;
    return `<g transform="translate(${x},${y}) scale(${scale.toFixed(3)})"><path fill="${color}" d="${d}"/></g>`;
}

// Key icon wrapper (72×72)
function keyIcon(body, bg = '#111111') {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="${bg}" rx="8"/>${body}</svg>`;
}

// ── Volume Dial ────────────────────────────────────────────────────────────

function volumeDialSvg({ volume = 65, muted = false, align = 'left', particles: showParticles = false }) {
    const cx = align === 'center' ? 100 : align === 'right' ? 150 : 50;
    const cy = 50;
    const rO = 38, rI = 30;

    let bg = showParticles
        ? `<rect width="200" height="100" fill="#000"/><g clip-path="url(#pc)">${particles(200, 100, 20, 42)}</g>`
        : `<rect width="200" height="100" fill="#0a0a0a"/>`;

    let pie = '';
    if (muted) {
        pie = mdiIcon(mdiVolumeOff, cx - rO, cy - rO, rO * 2, '#CCCCCC');
    } else {
        pie = `<circle cx="${cx}" cy="${cy}" r="${rO}" stroke="#CCCCCC" stroke-width="6" fill="none"/>` +
            piePath(cx, cy, rI, volume);
    }

    let text = '';
    if (align !== 'center') {
        const tx = align === 'right' ? 55 : 145;
        const label = muted ? 'MUTE' : `${volume}%`;
        text = `<text x="${tx}" y="46" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${label}</text>
                <text x="${tx}" y="64" fill="#999999" font-family="Arial,sans-serif" font-size="11" text-anchor="middle">Wohnzimmer</text>`;
    }

    const clipDef = showParticles ? `<defs><clipPath id="pc"><rect width="200" height="100"/></clipPath></defs>` : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        ${clipDef}${bg}${pie}${text}
    </svg>`;
}

// ── Track Dial ─────────────────────────────────────────────────────────────

function trackDialSvg({ mode = 'eq', state = 'playing', radio = false }) {
    const accent = radio ? '#E8883A' : '#5B8DD9';
    const textOpacity = state === 'paused' ? 0.55 : 1;
    const coverOpacity = state === 'paused' ? 0.55 : 1;

    const title = radio ? 'SWR3' : 'Bohemian Rhapsody';
    const artist = radio ? 'SWR3 — Live' : 'Queen';
    const progress = radio ? 0 : 38;

    let visualizer = '';
    if (mode === 'eq' && state === 'playing') {
        visualizer = eqBars(8, 88, accent);
    } else if (mode === 'particles') {
        visualizer = `<g clip-path="url(#pc)">${particles(100, 38, 12, 7)}</g>
            <defs><clipPath id="pc"><rect x="8" y="56" width="100" height="38"/></clipPath></defs>`;
    }

    const cover = `<defs>
        <linearGradient id="cvg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${radio ? '#2a1a4a' : '#1a2a4a'}"/>
            <stop offset="100%" stop-color="${radio ? '#4a1a2a' : '#4a2a1a'}"/>
        </linearGradient>
        <clipPath id="ccp"><rect x="113" y="4" width="83" height="92" rx="6"/></clipPath>
    </defs>
    <g clip-path="url(#ccp)" opacity="${coverOpacity}">
        <rect x="113" y="4" width="83" height="92" fill="url(#cvg)"/>
        <text x="154" y="53" fill="rgba(255,255,255,0.25)" font-size="28" text-anchor="middle" font-family="Arial">${radio ? '📻' : '♪'}</text>
    </g>`;

    const titleEl = `<text x="8" y="22" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="13" font-weight="bold" opacity="${textOpacity}"
        textLength="100" lengthAdjust="spacingAndGlyphs">${esc(title)}</text>`;
    const artistEl = `<text x="8" y="38" fill="#999999" font-family="Arial,sans-serif" font-size="11" opacity="${textOpacity}">${esc(artist)}</text>`;

    const progressBg = `<rect x="8" y="47" width="100" height="2" fill="#FFFFFF" opacity="0.12" rx="1"/>`;
    const progressFill = progress > 0
        ? `<rect x="8" y="47" width="${progress}" height="2" fill="${accent}" opacity="0.9" rx="1"/>`
        : '';

    const stateIcon = state === 'paused'
        ? `<text x="8" y="64" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="10" opacity="0.6">⏸ Paused</text>`
        : `<text x="8" y="64" fill="#999999" font-family="Arial,sans-serif" font-size="10">1:24 / 5:55</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        <rect width="200" height="100" fill="#000000"/>
        ${cover}
        <g clip-path="url(#tc)">
            ${titleEl}${artistEl}
        </g>
        <defs><clipPath id="tc"><rect x="8" y="4" width="100" height="90"/></clipPath></defs>
        ${progressBg}${progressFill}
        ${stateIcon}
        ${visualizer}
    </svg>`;
}

// ── Favorites Dial ─────────────────────────────────────────────────────────

function favoritesSvg() {
    const covers = ['#1a3a5a', '#3a1a5a', '#5a3a1a', '#1a5a3a', '#5a1a3a'];
    const titles = ['Chillout Lounge', '90s Mixtape', 'Jazz Classics', 'Deep Focus', 'Rock Anthems'];
    const active = 1;

    const covEl = coverPlaceholder(4, 8, 80, 84, covers[active], covers[(active + 1) % covers.length], 6);
    const title = `<text x="92" y="28" fill="#CCCCCC" font-family="Arial,sans-serif" font-size="13" font-weight="bold">${esc(titles[active])}</text>`;
    const pos = `<text x="92" y="46" fill="#999" font-family="Arial,sans-serif" font-size="11">${active + 1} / ${titles.length}</text>`;
    const dots = titles.map((_, i) =>
        `<circle cx="${92 + i * 14}" cy="62" r="${i === active ? 4 : 2.5}" fill="${i === active ? '#CCCCCC' : '#555'}"/>`
    ).join('');
    const now = `<text x="92" y="82" fill="#666" font-family="Arial,sans-serif" font-size="9">▶ Now: Chillout Lounge</text>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
        <rect width="200" height="100" fill="#0a0a0a"/>
        ${covEl}${title}${pos}${dots}${now}
    </svg>`;
}

// ── Panorama (4 dials) ─────────────────────────────────────────────────────

function panoramaSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="100" viewBox="0 0 800 100">
        <rect width="800" height="100" fill="#000"/>
        <defs><clipPath id="pan"><rect width="800" height="100"/></clipPath></defs>
        <g clip-path="url(#pan)">${particles(800, 100, 80, 99)}</g>
    </svg>`;
}

// ── Play/Pause Key ─────────────────────────────────────────────────────────

function playKeyWithCover(state = 'playing') {
    const accent = '#5B8DD9';
    const iconPath = state === 'playing' ? mdiPauseCircle : mdiPlayCircle;
    const coverGrad = `<defs>
        <linearGradient id="kg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#1a2a4a"/><stop offset="100%" stop-color="#4a2a1a"/>
        </linearGradient>
    </defs>
    <rect width="72" height="72" rx="8" fill="url(#kg)"/>`;
    const overlay = `<rect width="72" height="72" rx="8" fill="rgba(0,0,0,0.45)"/>`;
    const icon = mdiIcon(iconPath, 14, 14, 44, '#FFFFFF');
    const label = `<text x="36" y="66" fill="rgba(255,255,255,0.7)" font-size="8" text-anchor="middle" font-family="Arial">Bohemian Rhapsody</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">${coverGrad}${overlay}${icon}${label}</svg>`;
}

// ── Key icon helper ────────────────────────────────────────────────────────

function simpleKey(mdiPath, color = '#CCCCCC') {
    return keyIcon(mdiIcon(mdiPath, 10, 10, 52, color));
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('\nGenerating screenshots...\n');

// One representative screenshot per action
await savePng(trackDialSvg({ mode: 'eq', state: 'playing' }),          'track-dial.png', 3);
await savePng(volumeDialSvg({ volume: 65, align: 'left' }),            'volume-dial.png', 3);
await savePng(favoritesSvg(),                                           'favorites-dial.png', 3);
await savePng(panoramaSvg(),                                            'panorama-particles.png', 2);
await savePng(playKeyWithCover('paused'),                               'key-play-pause.png', 4);
await savePng(simpleKey(mdiSkipNext),                                   'key-playback-control.png', 4);
await savePng(simpleKey(mdiSkipNext, '#555555'),                        'key-playback-control-radio.png', 4);
await savePng(simpleKey(mdiVolumePlus),                                 'key-volume.png', 4);

// ── Lobster Plugin Icon ────────────────────────────────────────────────────

console.log('\nGenerating plugin icons...\n');

const lobsterSrc = path.join(ROOT, 'assets', 'lobster_icon.png');
const pluginImgs = path.join(ROOT, 'de.boriskemper.sonos-controller.sdPlugin', 'imgs', 'plugin');

async function makeLobsterIcon(size, outPath) {
    const { data, info } = await sharp(lobsterSrc)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    // Map brightness → alpha; set RGB to #CCCCCC
    const out = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0; i < info.width * info.height; i++) {
        const alpha = data[i * 4]; // R channel = brightness (grayscale source)
        out[i * 4 + 0] = 204;
        out[i * 4 + 1] = 204;
        out[i * 4 + 2] = 204;
        out[i * 4 + 3] = alpha;
    }

    await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toFile(outPath);
    console.log(`  ✓ ${path.basename(outPath)}`);
}

await makeLobsterIcon(72,  path.join(pluginImgs, 'lobster.png'));
await makeLobsterIcon(144, path.join(pluginImgs, 'lobster@2x.png'));

console.log(`\nDone — ${fs.readdirSync(OUT).length} screenshots + 2 plugin icons\n`);
