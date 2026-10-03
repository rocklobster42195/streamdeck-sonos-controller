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
