import sharp from 'sharp';
import fs from 'fs';

fs.mkdirSync('assets', { recursive: true });

const SAGE = '#87AE73';
const W = 1920, H = 1080;

function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

function genParticles(seed) {
    const r = rng(seed);
    const N = 200, CD = 180, CD2 = CD * CD;
    const pts = Array.from({ length: N }, () => ({ x: r() * W, y: r() * H, radius: 1.5 + r() * 3 }));
    const lines = [];
    for (let i = 0; i < N; i++)
        for (let j = i + 1; j < N; j++) {
            const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
            const d2 = dx * dx + dy * dy;
            if (d2 < CD2) {
                const op = ((1 - Math.sqrt(d2) / CD) * 0.4).toFixed(2);
                lines.push(`<line x1="${pts[i].x.toFixed(1)}" y1="${pts[i].y.toFixed(1)}" x2="${pts[j].x.toFixed(1)}" y2="${pts[j].y.toFixed(1)}" stroke="${SAGE}" stroke-width="1.5" opacity="${op}"/>`);
            }
        }
    const dots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${p.radius.toFixed(1)}" fill="${SAGE}" opacity="0.75"/>`);
    return [...lines, ...dots].join('\n');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#0a0a0a"/>
${genParticles(42001)}
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('assets/bg-particles-1080.png');
console.log('✓ assets/bg-particles-1080.png');
