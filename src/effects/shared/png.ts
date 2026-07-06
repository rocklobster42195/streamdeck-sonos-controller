import zlib from "node:zlib";

// Minimal synchronous RGBA PNG encoder — for any effect that needs to embed a raster image via
// <image href="data:image/png;base64,...">. renderSlice must return synchronously, which rules
// out async raster encoders like `sharp`; Node's zlib.deflateSync is enough to hand-roll a PNG.
//
// PNG, not BMP: an earlier version of Boing Ball tried a hand-rolled 32bpp BMP with alpha —
// libvips/sharp rejected it outright ("unsupported image format"), and alpha in plain BI_RGB BMP
// isn't reliably supported by real decoders in general. PNG's RGBA support is universal.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: ArrayLike<number>): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// ArrayLike<number> (not Buffer/Uint8Array) throughout: this @types/node version's Buffer and
// plain Uint8Array types don't structurally satisfy each other (Buffer's ArrayBufferLike-backed
// storage vs. Uint8Array defaulting to plain ArrayBuffer) even though every value here is a real
// Buffer at runtime. ArrayLike<number> sidesteps that nominal-typing mismatch entirely — it only
// needs `.length` and indexed reads, which both Buffer and Uint8Array satisfy trivially, and
// Uint8Array.prototype.set() (used instead of Buffer#copy) accepts it directly.
function concatBuffers(parts: ArrayLike<number>[]): Buffer {
    const out = Buffer.alloc(parts.reduce((sum, p) => sum + p.length, 0));
    let pos = 0;
    for (const part of parts) { out.set(part, pos); pos += part.length; }
    return out;
}

function pngChunk(type: string, data: ArrayLike<number>): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(concatBuffers([typeBuf, data])), 0);
    return concatBuffers([len, typeBuf, data, crc]);
}

/** Encodes an RGBA buffer (width*height*4 bytes) as a `data:image/png;base64,...` URI. */
export function encodePngDataUri(width: number, height: number, rgba: Uint8ClampedArray): string {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 6; // color type: RGBA
    const ihdr = pngChunk('IHDR', ihdrData);

    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const rowStart = y * (stride + 1);
        raw[rowStart] = 0; // filter type: none
        raw.set(new Uint8Array(rgba.buffer, rgba.byteOffset + y * stride, stride), rowStart + 1);
    }
    const idat = pngChunk('IDAT', zlib.deflateSync(new Uint8Array(raw)));
    const iend = pngChunk('IEND', Buffer.alloc(0));

    const png = concatBuffers([signature, ihdr, idat, iend]);
    return `data:image/png;base64,${png.toString('base64')}`;
}
