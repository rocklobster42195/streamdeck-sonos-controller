import { describe, it, expect } from 'vitest';
import { decodeImage, resizeRGBA } from './image-decode';
import { encodePngDataUri } from './png';

function pngBufferFromDataUri(dataUri: string): Buffer {
  return Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');
}

describe('decodeImage', () => {
  it('round-trips a PNG encoded by encodePngDataUri', () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const buf = pngBufferFromDataUri(encodePngDataUri(2, 2, rgba));

    const decoded = decodeImage(buf);

    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(2);
    expect(decoded!.height).toBe(2);
    expect(Array.from(decoded!.data)).toEqual(Array.from(rgba));
  });

  it('returns null for a buffer that is neither PNG nor JPEG', () => {
    expect(decodeImage(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for a truncated/corrupt PNG', () => {
    const buf = pngBufferFromDataUri(encodePngDataUri(2, 2, new Uint8ClampedArray(16)));
    expect(decodeImage(buf.subarray(0, 10))).toBeNull();
  });
});

describe('resizeRGBA', () => {
  it('downsamples to 1x1 by averaging every source pixel', () => {
    // Four corners: red, green, blue, white -> average is (127.5, 127.5, 127.5) rounded.
    const src = {
      width: 2,
      height: 2,
      data: [
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 255, 255, 255, 255,
      ],
    };

    const [r, g, b, a] = resizeRGBA(src, 1, 1);

    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
    expect(a).toBe(255);
  });

  it('box-averages a 4x4 image down to 2x2 quadrants', () => {
    // Each 2x2 quadrant is a solid color, so each output pixel should match its quadrant exactly.
    const px = (r: number, g: number, b: number) => [r, g, b, 255];
    const red = px(255, 0, 0), green = px(0, 255, 0), blue = px(0, 0, 255), yellow = px(255, 255, 0);
    const row = (left: number[], right: number[]) => [...left, ...left, ...right, ...right];
    const src = {
      width: 4,
      height: 4,
      data: [
        ...row(red, green),
        ...row(red, green),
        ...row(blue, yellow),
        ...row(blue, yellow),
      ],
    };

    const out = resizeRGBA(src, 2, 2);

    expect(Array.from(out)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
  });

  it('degrades to nearest-neighbor when upscaling', () => {
    const src = { width: 1, height: 1, data: [10, 20, 30, 255] };
    const out = resizeRGBA(src, 2, 2);
    expect(Array.from(out)).toEqual([
      10, 20, 30, 255, 10, 20, 30, 255,
      10, 20, 30, 255, 10, 20, 30, 255,
    ]);
  });
});
