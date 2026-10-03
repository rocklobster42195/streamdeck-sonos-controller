import { SonosDevice } from "@svrooij/sonos";
import { URL } from "url";
import { loadCover } from "@rocklobster42195/streamdeck-kit";
import { shrinkCover } from "../utils/cover-shrink";

// Covers come through the kit's cover cache, which carries this plugin's hardware lessons (they
// started here): one request per URL however many callers ask (Queue dial browsing, polls, track
// changes), at most two fetches per speaker at once, a stuck request aborted after 8 s so it frees
// its slot (once caused covers appearing only after 16+ s), and a failed URL resting 5 s — e.g.
// Sonos's getaa proxy URL for a NAS track can be malformed and 404 forever, which caused retry
// storms on every poll. What stays here: turning Sonos's relative URIs into full URLs, and shrinking the covers
// (see COVER_MAX_PX).

/** Shrunk covers by URL (decoding is the expensive part, so each cover only once). */
const shrunk = new Map<string, string>();
const SHRUNK_MAX = 200;

/** A cover as a data URI (at most COVER_MAX_PX on its longest side), or "" when it can't be loaded right now. */
export async function loadImageFromUri(uri: string, device: SonosDevice): Promise<string> {
  const url = resolveImageUrl(uri, device);
  const hit = shrunk.get(url);
  if (hit) return hit;
  const original = await loadCover(url);
  if (!original) return "";
  const small = shrinkCover(original);
  if (shrunk.size >= SHRUNK_MAX) shrunk.delete(shrunk.keys().next().value!);
  shrunk.set(url, small);
  return small;
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
