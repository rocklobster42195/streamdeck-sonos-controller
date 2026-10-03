import { decodeImage, resizeRGBA } from './image-decode';

/**
 * Keeps a dominant color usable as an accent on the dials' dark backgrounds: colors already
 * bright enough pass through, very dark ones get mixed toward white. Accepts getDominantColor's
 * "rgb(r,g,b)" output and "#rrggbb" (PI color pickers / placeholder constants) — the historical
 * per-action copies only matched rgb() and hit `fallback` for hex by accident; anything
 * unparseable still returns `fallback`.
 */
export function ensureVisibleColor(color: string, fallback = '#CCCCCC'): string {
    const rgb = parseColor(color);
    if (!rgb) return fallback;
    const [r, g, b] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum >= 0.25) return color;
    const mix = (v: number) => Math.min(255, Math.round(v * 255 + 255 * 0.55));
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function parseColor(color: string): [number, number, number] | null {
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
    const hexMatch = color.match(/^#([0-9a-f]{6})$/i);
    if (hexMatch) {
        const v = parseInt(hexMatch[1], 16);
        return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    }
    return null;
}

export async function getDominantColor(dataUri: string): Promise<string> {
    try {
        const comma = dataUri.indexOf(',');
        if (comma === -1) return '#CCCCCC';
        const buf = Buffer.from(dataUri.slice(comma + 1), 'base64');
        const decoded = decodeImage(buf);
        if (!decoded) return '#CCCCCC';
        const [r, g, b] = resizeRGBA(decoded, 1, 1);
        return `rgb(${r},${g},${b})`;
    } catch {
        return '#CCCCCC';
    }
}

/**
 * The cover's accent colour as an RGB triplet (like Music Assistant's palette accent): the average
 * of its most vivid pixels (saturation × brightness, top fifth of a 16×16 version), so a colourful
 * detail wins over a large grey area. undefined when the image can't be read.
 */
export function getAccentColor(dataUri: string): [number, number, number] | undefined {
    try {
        const comma = dataUri.indexOf(',');
        if (comma === -1) return undefined;
        const decoded = decodeImage(Buffer.from(dataUri.slice(comma + 1), 'base64'));
        if (!decoded) return undefined;
        const px = resizeRGBA(decoded, 16, 16);
        const scored: { s: number; c: [number, number, number] }[] = [];
        for (let i = 0; i < px.length; i += 4) {
            const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            scored.push({ s: max === 0 ? 0 : ((max - min) / max) * (max / 255), c: [r, g, b] });
        }
        scored.sort((a, b) => b.s - a.s);
        const top = scored.slice(0, Math.max(1, Math.round(scored.length / 5)));
        const avg = (k: 0 | 1 | 2) => Math.round(top.reduce((sum, p) => sum + p.c[k], 0) / top.length);
        return [avg(0), avg(1), avg(2)];
    } catch {
        return undefined;
    }
}
