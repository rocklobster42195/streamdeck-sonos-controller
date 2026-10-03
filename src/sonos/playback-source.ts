import type { PlaybackSource } from "./SonosTypes";

/** EnqueuedTransportURIMetaData (the lib's parsed Track, or raw DIDL-Lite) → the source, if it names one. */
export function parseSource(meta: unknown, uri: unknown): PlaybackSource | undefined {
  let title: string | undefined;
  let upnpClass: string | undefined;
  if (meta && typeof meta === 'object') {
    const t = meta as { Title?: unknown; UpnpClass?: unknown };
    if (typeof t.Title === 'string') title = t.Title;
    if (typeof t.UpnpClass === 'string') upnpClass = t.UpnpClass;
  } else if (typeof meta === 'string' && meta) {
    title = /<dc:title>([^<]*)<\/dc:title>/.exec(meta)?.[1];
    upnpClass = /<upnp:class>([^<]*)<\/upnp:class>/.exec(meta)?.[1];
  }
  title = title?.trim();
  if (!title) return undefined;
  return { title, upnpClass, uri: typeof uri === 'string' && uri ? uri : undefined };
}

/**
 * The source from an AVTransport event: EnqueuedTransportURI where the firmware still sends it,
 * else — when not playing from the queue (a station, Line-In) — what AVTransportURI names. Null
 * for queue playback without either (the local API may know more).
 */
export function upnpSourceOf(data: Record<string, unknown>): PlaybackSource | null {
  const enqueued = parseSource(data.EnqueuedTransportURIMetaData, data.EnqueuedTransportURI);
  if (enqueued) return enqueued;
  const uri = typeof data.AVTransportURI === 'string' ? data.AVTransportURI : '';
  if (uri && !uri.startsWith('x-rincon-queue:')) return parseSource(data.AVTransportURIMetaData, uri) ?? null;
  return null;
}
