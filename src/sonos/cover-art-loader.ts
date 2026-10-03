import { SonosDevice } from "@svrooij/sonos";
import { URL } from "url";
import { loadCover } from "@rocklobster42195/streamdeck-kit";

// Covers come through the kit's cover cache, which carries this plugin's hardware lessons (they
// started here): one request per URL however many callers ask (Queue dial browsing, polls, track
// changes), at most two fetches per speaker at once, a stuck request aborted after 8 s so it frees
// its slot (once caused covers appearing only after 16+ s), and a failed URL resting 5 s — e.g.
// Sonos's getaa proxy URL for a NAS track can be malformed and 404 forever, which caused retry
// storms on every poll. What stays here: turning Sonos's relative URIs into full URLs.

/** A cover as a data URI, or "" when it can't be loaded right now. */
export async function loadImageFromUri(uri: string, device: SonosDevice): Promise<string> {
  return (await loadCover(resolveImageUrl(uri, device))) ?? "";
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
