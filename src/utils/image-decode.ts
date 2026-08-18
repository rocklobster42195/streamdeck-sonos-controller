import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export interface DecodedImage {
    width: number;
    height: number;
    // ArrayLike<number>, not Buffer/Uint8Array: this @types/node version's Buffer and plain
    // Uint8Array don't structurally satisfy each other (see src/utils/png.ts), and this field
    // holds either a pngjs Buffer or a jpeg-js Uint8Array depending on source format. Only
    // indexed reads are needed here, which both satisfy.
    /** RGBA, 4 bytes per pixel. */
    data: ArrayLike<number>;
}

/**
 * Pure-JS PNG/JPEG decode (sniffed from the magic bytes) — Sonos cover art and favorite icons
 * arrive as either. Deliberately not sharp: sharp is a native module, so anything reachable from
 * src/plugin.ts must stay pure JS or the packed .streamDeckPlugin crashes on install (there's no
 * node_modules shipped alongside it — see the sharp removal commit for the full story).
 */
export function decodeImage(buf: Buffer): DecodedImage | null {
    try {
        if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            const png = PNG.sync.read(buf);
            return { width: png.width, height: png.height, data: png.data };
        }
        if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) {
            const raw = jpeg.decode(buf, { useTArray: true });
            return { width: raw.width, height: raw.height, data: raw.data };
        }
    } catch {
        // fall through to null below
    }
    return null;
}

/**
 * Box-filter resize: each destination pixel is the average of the source pixels it covers. Good
 * for downscaling (cover art -> 72x72 icon, or -> 1x1 for dominant-color sampling); degrades to
 * nearest-neighbor if ever used to upscale.
 */
export function resizeRGBA(src: DecodedImage, dstWidth: number, dstHeight: number): Uint8ClampedArray {
    const { width: sw, height: sh, data } = src;
    const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
    for (let dy = 0; dy < dstHeight; dy++) {
        const sy0 = Math.floor((dy * sh) / dstHeight);
        const sy1 = Math.max(sy0 + 1, Math.floor(((dy + 1) * sh) / dstHeight));
        for (let dx = 0; dx < dstWidth; dx++) {
            const sx0 = Math.floor((dx * sw) / dstWidth);
            const sx1 = Math.max(sx0 + 1, Math.floor(((dx + 1) * sw) / dstWidth));
            let r = 0, g = 0, b = 0, a = 0, count = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0; sx < sx1; sx++) {
                    const i = (sy * sw + sx) * 4;
                    r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3];
                    count++;
                }
            }
            const o = (dy * dstWidth + dx) * 4;
            out[o] = r / count;
            out[o + 1] = g / count;
            out[o + 2] = b / count;
            out[o + 3] = a / count;
        }
    }
    return out;
}
