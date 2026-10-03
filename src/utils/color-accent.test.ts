import { describe, expect, it } from 'vitest';
import { encodePngDataUri } from './png';
import { getAccentColor } from './color-extract';

describe('getAccentColor', () => {
    it('picks a colourful detail over a large grey area', () => {
        const size = 32;
        const rgba = new Uint8ClampedArray(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const i = (y * size + x) * 4;
                const red = x < 10 && y < 10;
                rgba.set(red ? [220, 30, 30, 255] : [120, 120, 120, 255], i);
            }
        }
        const [r, g, b] = getAccentColor(encodePngDataUri(size, size, rgba))!;
        expect(r).toBeGreaterThan(150);
        expect(g).toBeLessThan(90);
        expect(b).toBeLessThan(90);
    });

    it('returns undefined for something that is no image', () => {
        expect(getAccentColor('data:image/png;base64,AAAA')).toBeUndefined();
    });
});
