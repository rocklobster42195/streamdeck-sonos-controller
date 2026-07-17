import sharp from 'sharp';

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
        const { data } = await sharp(buf)
            .resize(1, 1, { fit: 'cover' })
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        return `rgb(${data[0]},${data[1]},${data[2]})`;
    } catch {
        return '#CCCCCC';
    }
}
