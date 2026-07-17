import sharp from 'sharp';

/**
 * Keeps a dominant color usable as an accent on the dials' dark backgrounds: colors already
 * bright enough pass through, very dark ones get mixed toward white. Accepts getDominantColor's
 * "rgb(r,g,b)" output; anything else (e.g. a "#rrggbb" initial placeholder) returns `fallback`.
 * Was copied into four actions with only the fallback constant differing.
 */
export function ensureVisibleColor(color: string, fallback = '#CCCCCC'): string {
    const m = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if (!m) return fallback;
    const [r, g, b] = [+m[1] / 255, +m[2] / 255, +m[3] / 255];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum >= 0.25) return color;
    const mix = (v: number) => Math.min(255, Math.round(v * 255 + 255 * 0.55));
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
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
