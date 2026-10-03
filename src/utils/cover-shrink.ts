import jpeg from 'jpeg-js';
import { decodeImage, resizeRGBA } from './image-decode';
import { encodePngDataUri } from './png';

/**
 * Longest side of a cover as the plugin keeps it. The largest cover drawn is 100 px (a dial), keys
 * draw 72 px; 144 stays sharp on high-resolution keys. Sonos hands out covers of 600 px and more
 * (100-300 KB): embedded in every frame of an animated dial or key that was several MB per second
 * to Stream Deck, which queued up and made the deck lag by seconds (hardware 2026-10-03).
 */
export const COVER_MAX_PX = 144;

/** `dataUri` shrunk to at most `max` px on its longest side; unchanged when smaller or not decodable. */
export function shrinkCover(dataUri: string, max = COVER_MAX_PX): string {
    const comma = dataUri.indexOf(',');
    if (!dataUri.startsWith('data:image/') || comma < 0 || !dataUri.slice(0, comma).endsWith(';base64')) return dataUri;
    const decoded = decodeImage(Buffer.from(dataUri.slice(comma + 1), 'base64'));
    if (!decoded || Math.max(decoded.width, decoded.height) <= max) return dataUri;
    const scale = max / Math.max(decoded.width, decoded.height);
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));
    const rgba = resizeRGBA(decoded, width, height);
    // PNGs keep their transparency (radio logos); photos stay JPEG, a fraction of a PNG's size
    if (dataUri.startsWith('data:image/png')) return encodePngDataUri(width, height, rgba);
    const out = jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }, 85);
    return `data:image/jpeg;base64,${Buffer.from(out.data).toString('base64')}`;
}
