import sharp from 'sharp';
import fs from 'fs';

const W = 1280;
const H = 640;
const SAGE = '#87AE73';

function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}
const r = rng(31337);

const N = 130;
const particles = Array.from({ length: N }, () => ({
    x: r() * W,
    y: r() * H,
    radius: 1.5 + r() * 3,
}));

const CD = 140;
const CD2 = CD * CD;

const linesSvg = [];
for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < CD2) {
            const dist = Math.sqrt(d2);
            const op = ((1 - dist / CD) * 0.5).toFixed(2);
            linesSvg.push(
                `<line x1="${particles[i].x.toFixed(1)}" y1="${particles[i].y.toFixed(1)}" ` +
                `x2="${particles[j].x.toFixed(1)}" y2="${particles[j].y.toFixed(1)}" ` +
                `stroke="${SAGE}" stroke-width="1.5" opacity="${op}"/>`
            );
        }
    }
}

const dotsSvg = particles.map(p =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.radius.toFixed(1)}" fill="${SAGE}" opacity="0.8"/>`
);

// Process high-res lobster: brightness → alpha, RGB → white
const lobsterSrc = 'de.boriskemper.sonos-controller.sdPlugin/assets/lobster_icon.png';
const { data, info } = await sharp(lobsterSrc)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

const out = Buffer.alloc(info.width * info.height * 4);
for (let i = 0; i < info.width * info.height; i++) {
    const brightness = data[i * 4]; // R channel — white=255, black=0
    out[i * 4 + 0] = 255;
    out[i * 4 + 1] = 255;
    out[i * 4 + 2] = 255;
    out[i * 4 + 3] = brightness;
}
const lobsterPng = await sharp(out, {
    raw: { width: info.width, height: info.height, channels: 4 },
}).png().toBuffer();
const lobsterHref = `data:image/png;base64,${lobsterPng.toString('base64')}`;

// Large lobster — left, vertically centered
const LS = 440;
const LX = 50;
const LY = Math.round((H - LS) / 2);

// Text — bottom right, no panel background
const TX = 720;
const TY_TITLE  = H - 148;
const TY_ARTIST = H - 106;
const TY_LINE   = H - 88;
const TY_META   = H - 50;
const LINE_W    = W - TX - 40;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
<defs>
  <radialGradient id="lglow" cx="${LX + LS / 2}" cy="${LY + LS / 2}" r="${LS * 0.55}" gradientUnits="userSpaceOnUse">
    <stop offset="0%"   stop-color="${SAGE}" stop-opacity="0.09"/>
    <stop offset="100%" stop-color="${SAGE}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="txtfade" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%"   stop-color="#000" stop-opacity="0"/>
    <stop offset="25%"  stop-color="#000" stop-opacity="0.65"/>
    <stop offset="100%" stop-color="#000" stop-opacity="0.65"/>
  </linearGradient>
</defs>

<rect width="${W}" height="${H}" fill="#000"/>

${linesSvg.join('\n')}
${dotsSvg.join('\n')}

<rect width="${W}" height="${H}" fill="url(#lglow)"/>

<image href="${lobsterHref}" x="${LX}" y="${LY}" width="${LS}" height="${LS}" preserveAspectRatio="xMidYMid meet"/>

<rect x="${TX - 40}" y="${TY_TITLE - 52}" width="${W - TX + 40}" height="${H - TY_TITLE + 72}" fill="url(#txtfade)"/>

<text x="${TX}" y="${TY_TITLE}"  fill="#fff"    font-size="36" font-family="Arial, Helvetica, sans-serif" font-weight="700">Sonos Controller</text>
<text x="${TX}" y="${TY_ARTIST}" fill="#aaaaaa" font-size="22" font-family="Arial, Helvetica, sans-serif">for Elgato Stream Deck+</text>
<rect x="${TX}" y="${TY_LINE}"   width="${LINE_W}" height="2.5" fill="${SAGE}" opacity="0.9" rx="1.5"/>
<text x="${TX}" y="${TY_META}"   fill="${SAGE}"  font-size="19" font-family="Arial, Helvetica, sans-serif" opacity="0.9">▶  Rocklobster</text>

</svg>`;

fs.mkdirSync('assets', { recursive: true });
await sharp(Buffer.from(svg)).png().toFile('assets/store-banner.png');
console.log('✓ assets/store-banner.png (1280×640)');
