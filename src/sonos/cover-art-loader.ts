import streamDeck from "@elgato/streamdeck";
import { SonosDevice } from "@svrooij/sonos";
import { URL } from "url";
import { runThrottled } from "./per-host-throttle";

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

