import sharp from 'sharp';
import fs from 'fs';
import { mdiPlayCircle, mdiSkipNext, mdiVolumeHigh, mdiStar } from '@mdi/js';

fs.mkdirSync('assets', { recursive: true });

const SAGE = '#87AE73';
const SAGE_R = 0x87, SAGE_G = 0xAE, SAGE_B = 0x73;
const W = 1920, H = 960;

const lobsterSrc = 'de.boriskemper.sonos-controller.sdPlugin/assets/lobster_icon.png';
const { data, info } = await sharp(lobsterSrc).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const outSage = Buffer.alloc(info.width * info.height * 4);
for (let i = 0; i < info.width * info.height; i++) {
    const t = data[i * 4] / 255;
    outSage[i*4+0] = Math.round(SAGE_R * (1-t));
    outSage[i*4+1] = Math.round(SAGE_G * (1-t));
    outSage[i*4+2] = Math.round(SAGE_B * (1-t));
    outSage[i*4+3] = 255;
}
const lobSagePng = await sharp(outSage, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
const lobSageHref = `data:image/png;base64,${lobSagePng.toString('base64')}`;

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

function genParticles(seed) {
    const r = rng(seed);
    const N = 160, CD = 175, CD2 = CD * CD;
    const pts = Array.from({ length: N }, () => ({ x: r() * W, y: r() * H, radius: 1.5 + r() * 3 }));
    const lines = [];
    for (let i = 0; i < N; i++)
        for (let j = i+1; j < N; j++) {
            const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
            const d2 = dx*dx + dy*dy;
            if (d2 < CD2) {
                const op = ((1 - Math.sqrt(d2)/CD) * 0.4).toFixed(2);
                lines.push(`<line x1="${pts[i].x.toFixed(1)}" y1="${pts[i].y.toFixed(1)}" x2="${pts[j].x.toFixed(1)}" y2="${pts[j].y.toFixed(1)}" stroke="${SAGE}" stroke-width="1.5" opacity="${op}"/>`);
            }
        }
    const dots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.radius.toFixed(1)}" fill="${SAGE}" opacity="0.75"/>`);
    return [...lines, ...dots].join('\n');
}

// Render an MDI icon centered at (cx, cy) at given pixel size
function mdiIcon(path, cx, cy, size, color = SAGE) {
    const scale = size / 24;
    const tx = cx - size / 2, ty = cy - size / 2;
    return `<g transform="translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${scale.toFixed(4)})"><path fill="${color}" d="${path}"/></g>`;
}

async function render(svgStr, outFile) {
    await sharp(Buffer.from(svgStr)).png().toFile(outFile);
    console.log(`✓ ${outFile}`);
}

// ── Image 1: Track Dial ───────────────────────────────────────────────────────
{
    const eqR = rng(7777);
    const BAR_COUNT = 24, BAR_MAX = 110;
    const bars = Array.from({ length: BAR_COUNT }, () => 20 + eqR() * BAR_MAX);

    const PX = 240, PY = 130, PW = 1440, PH = 600;
    const ART = PH;
    const IX = PX + ART + 60, IW = PW - ART - 60;
    const EQ_BOT = PY + PH - 28;
    const EQ_UNIT = Math.floor((IW - 40) / BAR_COUNT);
    const EQ_BW = Math.max(8, Math.floor(EQ_UNIT * 0.6));

    const eqBarsSvg = bars.map((bh, i) => {
        const bx = IX + 20 + i * EQ_UNIT;
        return `<rect x="${bx}" y="${(EQ_BOT-bh).toFixed(0)}" width="${EQ_BW}" height="${bh.toFixed(0)}" rx="2" fill="${SAGE}" opacity="0.65"/>`;
    }).join('\n');

    const PROG_Y = EQ_BOT - BAR_MAX - 36;
    const PROG_W = IW - 40;
    const PROG_F = Math.round(PROG_W * 0.62);

    await render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
<defs>
  <clipPath id="artclip"><rect x="${PX}" y="${PY}" width="${ART}" height="${ART}" rx="20"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0a0a0a"/>
${genParticles(42001)}
<rect x="${PX-40}" y="${PY-40}" width="${PW+80}" height="${PH+80}" rx="32" fill="#000" opacity="0.45"/>
<rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="20" fill="#141414"/>
<image href="${lobSageHref}" x="${PX}" y="${PY}" width="${ART}" height="${ART}" clip-path="url(#artclip)" preserveAspectRatio="xMidYMid slice"/>
<text x="${IX}" y="${PY+108}" fill="#fff" font-size="56" font-family="Arial,Helvetica,sans-serif" font-weight="700">Rock Lobster</text>
<text x="${IX}" y="${PY+166}" fill="#888" font-size="36" font-family="Arial,Helvetica,sans-serif">The B-52's</text>
<rect x="${IX+20}" y="${PROG_Y}" width="${PROG_W}" height="7" rx="3" fill="#2a2a2a"/>
<rect x="${IX+20}" y="${PROG_Y}" width="${PROG_F}" height="7" rx="3" fill="${SAGE}"/>
<text x="${IX+20}" y="${PROG_Y-14}" fill="#555" font-size="22" font-family="Arial,Helvetica,sans-serif">2:21</text>
<text x="${IX+20+PROG_W}" y="${PROG_Y-14}" fill="#555" font-size="22" font-family="Arial,Helvetica,sans-serif" text-anchor="end">3:49</text>
${eqBarsSvg}
<text x="${W/2}" y="${H-38}" text-anchor="middle" fill="${SAGE}" font-size="30" font-family="Arial,Helvetica,sans-serif" font-weight="600">Track Dial — live cover art · track info · EQ Effect</text>
</svg>`, 'assets/store-showcase-track.png');
}

// ── Image 2: Favorites Dial — faithful 5× scale mockup of the actual plugin UI
{
    // Source LCD: 200×100 px, scale = 5x → 1000×500
    const S = 5;
    const PW = 200 * S, PH = 100 * S;
    const PX = Math.round((W - PW) / 2), PY = Math.round((H - PH) / 2) - 30;

    // Cover art: source (4,6) 88×88 with clip rx=6
    const AX = PX + 4*S, AY = PY + 6*S, AW = 88*S, AH = 88*S;

    // Text positions (right column starts at x=100 in source)
    const TX = PX + 100*S;
    const TY_TITLE = PY + 30*S;    // title baseline
    const TY_SUB   = PY + 48*S;    // "Press to play"
    const TY_POS   = PY + 62*S;    // position counter (right-aligned)
    const POS_X    = PX + 197*S;   // right-align anchor

    // Dots: 5 favorites, current index = 3 (0-based), total = 5
    const TOTAL = 5, ACTIVE_I = 3;
    const GAP = Math.round(180 / (TOTAL - 1));
    const DOTS_START_X = Math.round((200 - (TOTAL - 1) * GAP) / 2);
    const DY = PY + 88*S;
    const dotsSvg = Array.from({ length: TOTAL }, (_, i) => {
        const dx = PX + DOTS_START_X * S + i * GAP * S;
        const isActive = i === ACTIVE_I;
        const dr = (isActive ? 3.5 : 2.5) * S;
        const fill = isActive ? '#FFFFFF' : '#484848';
        return `<circle cx="${dx}" cy="${DY}" r="${dr}" fill="${fill}"/>`;
    }).join('');

    await render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
<defs>
  <clipPath id="artclip"><rect x="${AX}" y="${AY}" width="${AW}" height="${AH}" rx="${6*S}"/></clipPath>
  <clipPath id="panelclip"><rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" rx="${8*S}"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0a0a0a"/>
${genParticles(53002)}
<!-- Shadow -->
<rect x="${PX-40}" y="${PY-40}" width="${PW+80}" height="${PH+80}" rx="${20*S}" fill="#000" opacity="0.45"/>
<!-- LCD panel background -->
<rect x="${PX}" y="${PY}" width="${PW}" height="${PH}" fill="#1c1c1c" clip-path="url(#panelclip)"/>
<!-- Cover art -->
<image href="${lobSageHref}" x="${AX}" y="${AY}" width="${AW}" height="${AH}" clip-path="url(#artclip)" preserveAspectRatio="xMidYMid slice"/>
<!-- Title -->
<text x="${TX}" y="${TY_TITLE}" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="${14*S}" clip-path="url(#panelclip)">Rock Lobster</text>
<!-- Subtitle -->
<text x="${TX}" y="${TY_SUB}" fill="#888888" font-family="Arial,sans-serif" font-size="${11*S}">Press to play</text>
<!-- Position counter -->
<text x="${POS_X}" y="${TY_POS}" fill="#666666" font-family="Arial,sans-serif" font-size="${10*S}" text-anchor="end">4 / 5</text>
<!-- Dots -->
${dotsSvg}
<!-- Browse border -->
<rect x="${PX+2}" y="${PY+2}" width="${PW-4}" height="${PH-4}" fill="none" stroke="#ffffff" stroke-width="${3*S}" stroke-opacity="0.12" rx="${8*S}"/>
<!-- Caption -->
<text x="${W/2}" y="${H-38}" text-anchor="middle" fill="${SAGE}" font-size="30" font-family="Arial,Helvetica,sans-serif" font-weight="600">Favorites Dial — browse &amp; play your Sonos favorites</text>
</svg>`, 'assets/store-showcase-favorites.png');
}

// ── Image 3: Key Actions — MDI icons ─────────────────────────────────────────
{
    const S = 370, GAP = 44;
    const ROW_W = 4 * S + 3 * GAP;
    const X0 = Math.round((W - ROW_W) / 2);
    const KY = Math.round((H - S) / 2) - 36;
    const kx = [0,1,2,3].map(i => X0 + i * (S + GAP));
    const kcx = kx.map(x => x + S/2);
    const kcy = KY + S/2;
    const labelY = KY + S + 48;
    const ICON_SIZE = 176;

    await render(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
<defs>
  <clipPath id="k1c"><rect x="${kx[0]}" y="${KY}" width="${S}" height="${S}" rx="28"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="#0a0a0a"/>
${genParticles(64003)}

<!-- Key 1: Play / Pause — cover art + play overlay -->
<image href="${lobSageHref}" x="${kx[0]}" y="${KY}" width="${S}" height="${S}" clip-path="url(#k1c)" preserveAspectRatio="xMidYMid slice"/>
<rect x="${kcx[0]-48}" y="${kcy-48}" width="96" height="96" rx="48" fill="#000" opacity="0.52"/>
${mdiIcon(mdiPlayCircle, kcx[0], kcy, ICON_SIZE - 80, '#ffffff')}
<text x="${kcx[0]}" y="${labelY}" text-anchor="middle" fill="#aaa" font-size="24" font-family="Arial,Helvetica,sans-serif">Play / Pause</text>

<!-- Key 2: Playback Control -->
<rect x="${kx[1]}" y="${KY}" width="${S}" height="${S}" rx="28" fill="#1a1a1a"/>
${mdiIcon(mdiSkipNext, kcx[1], kcy, ICON_SIZE)}
<text x="${kcx[1]}" y="${labelY}" text-anchor="middle" fill="#aaa" font-size="24" font-family="Arial,Helvetica,sans-serif">Playback Control</text>

<!-- Key 3: Volume Control -->
<rect x="${kx[2]}" y="${KY}" width="${S}" height="${S}" rx="28" fill="#1a1a1a"/>
${mdiIcon(mdiVolumeHigh, kcx[2], kcy, ICON_SIZE)}
<text x="${kcx[2]}" y="${labelY}" text-anchor="middle" fill="#aaa" font-size="24" font-family="Arial,Helvetica,sans-serif">Volume Control</text>

<!-- Key 4: Play Favorite -->
<rect x="${kx[3]}" y="${KY}" width="${S}" height="${S}" rx="28" fill="#1a1a1a"/>
${mdiIcon(mdiStar, kcx[3], kcy, ICON_SIZE)}
<text x="${kcx[3]}" y="${labelY}" text-anchor="middle" fill="#aaa" font-size="24" font-family="Arial,Helvetica,sans-serif">Play Favorite</text>

<text x="${W/2}" y="${H-38}" text-anchor="middle" fill="${SAGE}" font-size="30" font-family="Arial,Helvetica,sans-serif" font-weight="600">8 actions — keys &amp; dials for full Sonos control</text>
</svg>`, 'assets/store-showcase-keys.png');
}
