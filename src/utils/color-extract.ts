import sharp from 'sharp';

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
