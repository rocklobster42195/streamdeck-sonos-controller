import streamDeck from "@elgato/streamdeck";
import { SonosDevice } from "@svrooij/sonos";
import { URL } from "url";
import { generateVolumeLevelIcon } from "../utils/icons";
import { runThrottled } from "./perHostThrottle";

// Every caller that wants a cover (Queue Dial's cursor/prefetch, Track Dial, PlayPause,
// SonosDeviceController's currentTrack/polling paths, ...) used to call straight through to
// fetch() with no shared bookkeeping. Confirmed on hardware this caused two compounding problems:
// (1) the SAME resolved URL got fetched multiple times concurrently (e.g. Queue Dial browsing
// back over an item it already just fetched, or a background poll re-requesting the currently
// playing track's art while a dial's own fetch for that exact cover was still in flight) — each
// duplicate ate one of only MAX_CONCURRENT_PER_HOST slots in the per-host throttle for no reason,
// and (2) a single stuck fetch (Sonos's own art proxy hanging on a cache miss) occupied its slot
// forever, since nothing aborted the underlying request — every later request for that device
// queued up behind it, observed as covers only appearing after 16+ seconds (two stuck/slow
// requests deep) and even starving unrelated actions (Track Dial, PlayPause) sharing the host.
// Fixing this here, once, means every caller benefits without re-implementing it.
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESOLVED_CACHE = 100;
const resolvedCache: Map<string, string> = new Map();
const pendingFetches: Map<string, Promise<string>> = new Map();

export async function loadImageFromUri(uri: string, device: SonosDevice): Promise<string> {
  const fullImageUrl = resolveImageUrl(uri, device);

  const cached = resolvedCache.get(fullImageUrl);
  if (cached) return cached;

  const existing = pendingFetches.get(fullImageUrl);
  if (existing) return existing;

  const promise = runThrottled(device.Host, () => loadImageFromUriUnthrottled(fullImageUrl))
    .finally(() => { pendingFetches.delete(fullImageUrl); });
  pendingFetches.set(fullImageUrl, promise);

  const dataUri = await promise;
  if (dataUri) {
    if (resolvedCache.size >= MAX_RESOLVED_CACHE && !resolvedCache.has(fullImageUrl)) {
      const oldestKey = resolvedCache.keys().next().value;
      if (oldestKey !== undefined) resolvedCache.delete(oldestKey);
    }
    resolvedCache.set(fullImageUrl, dataUri);
  }
  return dataUri;
}

function resolveImageUrl(uri: string, device: SonosDevice): string {
  const baseUrl = `http://${device.Host}:${device.Port}`;
  let fullImageUrl = new URL(uri, baseUrl).toString();

  // Sanitize the URL: replace subsequent '?' with '&'
  const firstQuestionMarkIndex = fullImageUrl.indexOf('?');
  if (firstQuestionMarkIndex !== -1) {
    const path = fullImageUrl.substring(0, firstQuestionMarkIndex + 1);
    const query = fullImageUrl.substring(firstQuestionMarkIndex + 1).replace(/\?/g, '&');
    fullImageUrl = path + query;
  }
  return fullImageUrl;
}

async function loadImageFromUriUnthrottled(fullImageUrl: string): Promise<string> {
  // AbortController (not a Promise.race-style timeout) so a stuck request is actually cancelled
  // at the socket level once it times out, instead of just being abandoned while it keeps running
  // in the background — the latter would still hold its per-host throttle slot indefinitely.
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(fullImageUrl, { signal: abortController.signal });
    streamDeck.logger.debug(`Image fetch response status: ${response.status}`);

    if (!response.ok) {
      streamDeck.logger.error(`Failed to fetch image: ${response.statusText}`);
      return ""; // Return empty string or a default image path
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      streamDeck.logger.error(`Empty image body from ${fullImageUrl}`);
      return "";
    }

    const mimeType = response.headers.get('content-type') ?? 'image/jpeg';
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('binary/')) {
      streamDeck.logger.error(`Non-image MIME type "${mimeType}" from ${fullImageUrl}`);
      return "";
    }

    const base64String = Buffer.from(arrayBuffer).toString("base64");
    const dataUri = `data:${mimeType};base64,${base64String}`;
    return dataUri;
  } catch (error) {
    streamDeck.logger.error("Error in loadImageFromUri:", error);
    return ""; // Return empty string or a default image path on error
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getIconByVolume(volume: number): string {
  return generateVolumeLevelIcon(volume, false);
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
