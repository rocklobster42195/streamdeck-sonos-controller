// Pure metadata heuristics for Sonos track/radio quirks — extracted from
// SonosDeviceController so they are individually documented, dependency-free and reusable.

import { MetaDataHelper } from "@svrooij/sonos";

export function isRadioAlbumArtUri(albumArtUri: string | undefined): boolean {
  if (!albumArtUri) return false;
  // Sonos Radio (Deezer-powered) serves cover art from sonosradio.imgix.net — no u= parameter.
  if (albumArtUri.includes('sonosradio.imgix.net')) return true;
  const match = albumArtUri.match(/[?&]u=([^&]+)/);
  if (!match) return false;
  return MetaDataHelper.IsRadioStream(decodeURIComponent(match[1]));
}

// Sonos' own TuneIn-logo resize proxy (e.g. https://sali.sonos.superhi.fi/image?w=60&image=
// <original-logo-url>&partnerId=tunein, surfaced via GetMediaInfo's CurrentURIMetaData for
// stations with no useful GetPositionInfo metadata) defaults to a tiny width — 60px, meant for
// a small list-row icon — which looks visibly pixelated stretched across the much larger Track
// Dial cover area. Bump the requested width up via the same proxy rather than fetching the
// (potentially much larger/wrong-format) original directly.
export function upsizeSonosImageProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('sonos.superhi.fi') || !u.searchParams.has('w')) return url;
    u.searchParams.set('w', '300');
    return u.toString();
  } catch {
    return url;
  }
}

// Detects a "Title" that's actually just the trailing filename/query segment of a raw stream
// URL — Sonos' own fallback when a station provides no real metadata in GetPositionInfo (e.g.
// "stream.mp3?aggregator=tunein&cid=..."). Confirmed on hardware for a WDR2/TuneIn stream; used
// to prefer GetMediaInfo's CurrentURIMetaData (the real station name) instead — see
// getCurrentTrack().
export function looksLikeRawStreamFilename(title: string | undefined): boolean {
  if (!title) return false;
  return /\.(mp3|aac|m4a|ogg|flac|wav|m3u8?|pls)(\?|$)/i.test(title);
}
