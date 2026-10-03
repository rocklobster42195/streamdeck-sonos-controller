import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { decodeImage } from './image-decode';
import { encodePngDataUri } from './png';
import { shrinkCover } from './cover-shrink';

const sizeOf = (uri: string) => decodeImage(Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64'))!;

function jpegUri(width: number, height: number): string {
    const data = Buffer.alloc(width * height * 4, 200);
    return `data:image/jpeg;base64,${Buffer.from(jpeg.encode({ data, width, height }, 90).data).toString('base64')}`;
}

describe('shrinkCover', () => {
    it('shrinks a large JPEG to the longest side, keeping the aspect ratio', () => {
        const small = shrinkCover(jpegUri(600, 300));
        expect(small.startsWith('data:image/jpeg;base64,')).toBe(true);
        expect(sizeOf(small)).toMatchObject({ width: 144, height: 72 });
    });

    it('keeps a large PNG a PNG (transparency)', () => {
        const big = encodePngDataUri(300, 300, new Uint8ClampedArray(300 * 300 * 4));
        const small = shrinkCover(big);
        expect(small.startsWith('data:image/png;base64,')).toBe(true);
        expect(sizeOf(small)).toMatchObject({ width: 144, height: 144 });
    });

    it('leaves small covers and non-images alone', () => {
        const small = jpegUri(100, 100);
        expect(shrinkCover(small)).toBe(small);
        expect(shrinkCover('')).toBe('');
        expect(shrinkCover('data:image/svg+xml;utf8,<svg/>')).toBe('data:image/svg+xml;utf8,<svg/>');
    });
});
