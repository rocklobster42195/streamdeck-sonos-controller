import streamDeck from "@elgato/streamdeck";
import { SonosDevice } from "@svrooij/sonos";
import { URL } from "url";

export async function loadImageFromUri(uri: string, device: SonosDevice): Promise<string> {
  try {
    const baseUrl = `http://${device.Host}:${device.Port}`;
    let fullImageUrl = new URL(uri, baseUrl).toString();

    // Sanitize the URL: replace subsequent '?' with '&'
    const firstQuestionMarkIndex = fullImageUrl.indexOf('?');
    if (firstQuestionMarkIndex !== -1) {
      const path = fullImageUrl.substring(0, firstQuestionMarkIndex + 1);
      const query = fullImageUrl.substring(firstQuestionMarkIndex + 1).replace(/\?/g, '&');
      fullImageUrl = path + query;
    }

    const response = await fetch(fullImageUrl);
    streamDeck.logger.debug(`Image fetch response status: ${response.status}`);

    if (!response.ok) {
      streamDeck.logger.error(`Failed to fetch image: ${response.statusText}`);
      return ""; // Return empty string or a default image path
    }

    const arrayBuffer = await response.arrayBuffer();
    const base64String = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    streamDeck.logger.debug(`Image MIME type: ${mimeType}`);

    const dataUri = `data:${mimeType};base64,${base64String}`;
    // streamDeck.logger.debug(`Generated data URI: ${dataUri.substring(0, 100)}...`); // Don't log the full URI
    return dataUri;
  } catch (error) {
    streamDeck.logger.error("Error in loadImageFromUri:", error);
    return ""; // Return empty string or a default image path on error
  }
}

export function getIconByVolume(volume: number): string {
  switch (true) {
    case volume < 10:
      return "imgs/actions/sonos-dial-volume/volume-low-cccccc";
    case volume < 60:
      return "imgs/actions/sonos-dial-volume/volume-medium-cccccc";
    default:
      return "imgs/actions/sonos-dial-volume/volume-high-cccccc";
  }
}

export function generateFaderSvg(levelPercent: number, isMuted: boolean, color: string): string {
    const bgcolor = "transparent";
    const percent = Math.max(0.0, Math.min(levelPercent, 100.0));

    // Dimensions for "padding" to the edge
    const cx = 12;
    const cy = 12;
    const rOuter = 9; // Was 10 -> now more space to the edge (24px box)
    const rInner = 7; // Was 8 -> smaller "pie" for a nicer look

    let innerContent: string;

    if (isMuted) {
        // Mute path scaled (0.8) and centered for more padding
        innerContent = `
            <g >
                <path fill="${color}" d="M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z" />
            </g>
        `;
    } else {
        // Pie chart logic with new rInner
        let path: string;
        if (percent >= 99.9) {
            path = `<circle cx="${cx}" cy="${cy}" r="${rInner}" fill="${color}" stroke-width="0" />`;
        } else if (percent <= 0.1) {
            path = "";
        } else {
            const angleDeg = (percent / 100.0) * 360.0;
            const angleRad = (angleDeg - 90) * (Math.PI / 180.0);
            const xEnd = cx + rInner * Math.cos(angleRad);
            const yEnd = cy + rInner * Math.sin(angleRad);
            const largeArcFlag = angleDeg > 180 ? 1 : 0;

            const pathD = `M ${cx} ${cy} L ${cx} ${cy - rInner} A ${rInner} ${rInner} 0 ${largeArcFlag} 1 ${xEnd} ${yEnd} Z`;
            path = `<path d="${pathD}" fill="${color}" stroke-width="0" />`;
        }

        // Outer ring with rOuter
        innerContent = `<circle cx="${cx}" cy="${cy}" r="${rOuter}" stroke="${color}" stroke-width="1.5" fill="none"/>${path}`;
    }

    // Complete SVG XML
    const svgRaw = `
        <?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="144" width="144">
            <rect width="24" height="24" fill="${bgcolor}"></rect>
            ${innerContent}
        </svg>
    `.trim();

    // Convert to Base64
    const b64Svg = Buffer.from(svgRaw).toString('base64');
    return `data:image/svg+xml;base64,${b64Svg}`;
}
