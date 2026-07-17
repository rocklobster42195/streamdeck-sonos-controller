import streamDeck from "@elgato/streamdeck";
import { SonosDevice, MetaDataHelper } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./sonos-discovery";
import { SonosFavorite } from "./SonosTypes";
import { escapeXml, decodeXmlEntities } from "../utils/xml";

// Sonos's own ContentDirectoryService.Browse can return a URI that is only PARTIALLY
// percent-encoded — a NAS folder with a space in its name (e.g. "ABBA - Gold Greatest Hits",
// "NuDisco 2") came back with the filename segment properly escaped (%20) but the containing
// folder segment left as raw, literal spaces. Re-encodes any character outside the RFC 3986
// unreserved/reserved set, while leaving already-valid %XX escapes alone (so an already-encoded
// filename segment isn't double-encoded into %2520) and URI-structural characters untouched.
const URI_SAFE_CHAR = /[A-Za-z0-9\-_.!~*'();/?:@&=+$,#]/;
function normalizeUri(uri: string): string {
    return uri.replace(/%[0-9A-Fa-f]{2}|./gs, (match) => {
        if (/^%[0-9A-Fa-f]{2}$/.test(match)) return match;
        if (URI_SAFE_CHAR.test(match)) return match;
        return encodeURIComponent(match);
    });
}

// The item's own id/parentID reference the same NAS share path as its <res> URI (just without a
// scheme) and carry the identical raw-space problem.
function patchItemIds(itemXml: string): string {
    return itemXml.replace(/ (id|parentID)="([^"]*)"/g, (_m, attr: string, val: string) => ` ${attr}="${escapeXml(normalizeUri(decodeXmlEntities(val)))}"`);
}

// MetadataHelper.TrackToMetaData — the SDK's OWN metadata builder, used by the Spotify path a
// few lines below — never includes a <res> element, only id/parentID/title/class(/desc).
// AddURIToQueue already receives the resource location via the separate top-level EnqueuedURI
// field, so a <res> duplicating that same URI inside EnqueuedURIMetaData is redundant. Kept out
// for consistency with the working paths, alongside the actual root cause fixed at the
// AddURIToQueue call sites below (see the escapeXml comment there — a raw, unescaped metadata
// string was the real reason every NAS/CIFS AddURIToQueue attempt got UPnPError 402, confirmed
// on hardware 2026-07-17, regardless of what the metadata content said).
function stripResTag(itemXml: string): string {
    return itemXml.replace(/<res[^>]*>[\s\S]*?<\/res>/, '');
}

/**
 * Plays a Sonos favorite on one device, dispatching on the favorite's URI type (Spotify
 * playlist / music-library folder / radio-direct URI) — extracted verbatim from
 * SonosDeviceController, which now only delegates. Owns all DIDL-Lite metadata building and
 * the custom NAS-folder expansion. Deliberately targets the given device directly (not the
 * group coordinator): Sonos routes queue/transport changes correctly from any member here.
 */
export class SonosFavoritePlayer {
  constructor(private readonly sonosDevice: SonosDevice) {}

  private async handleLocalFolder(favorite: SonosFavorite): Promise<boolean> {
      const logPrefix = `[LocalFolder]`;
      streamDeck.logger.info(`${logPrefix} Browsing folder content...`);

      try {
          let result: any = null;
          
          try {
             result = await this.sonosDevice.ContentDirectoryService.Browse({
                ObjectID: favorite.ItemId ?? '',
                BrowseFlag: 'BrowseDirectChildren',
                Filter: '*',
                StartingIndex: 0,
                RequestedCount: 1000, 
                SortCriteria: ''
             });
          } catch { /* ignore */ }

          if (!result || !result.Result || !result.Result.includes('<item')) {
               const hashIndex = favorite.TrackUri.indexOf('#');
               if (hashIndex > -1) {
                   const realObjectId = favorite.TrackUri.substring(hashIndex + 1);
                   try {
                       result = await this.sonosDevice.ContentDirectoryService.Browse({
                          ObjectID: realObjectId,
                          BrowseFlag: 'BrowseDirectChildren',
                          Filter: '*',
                          StartingIndex: 0,
                          RequestedCount: 1000, 
                          SortCriteria: ''
                       });
                   } catch {
                       try {
                           const encodedId = encodeURIComponent(realObjectId).replace(/%2F/g, '/').replace(/%3A/g, ':');
                           result = await this.sonosDevice.ContentDirectoryService.Browse({
                              ObjectID: encodedId,
                              BrowseFlag: 'BrowseDirectChildren',
                              Filter: '*',
                              StartingIndex: 0,
                              RequestedCount: 1000, 
                              SortCriteria: ''
                           });
                       } catch { /* ignore */ }
                   }
               }
          }

          if (!result || typeof result.Result !== 'string') {
              streamDeck.logger.warn(`${logPrefix} No XML result.`);
              return false;
          }

          // Local shape for parsed folder entries — deliberately NOT the plugin-wide TrackInfo
          // type (which this used to shadow confusingly).
          interface FolderTrack {
              uri: string;
              metadata: string;
              sortKey: string;
          }

          const items: FolderTrack[] = [];
          const itemRegex = /<item[\s\S]*?<\/item>/g;
          let itemMatch;

          while ((itemMatch = itemRegex.exec(result.Result)) !== null) {
              const itemXml = itemMatch[0];
              const resMatch = itemXml.match(/<res[^>]*>(.*?)<\/res>/);

              if (resMatch && resMatch[1]) {
                  // Decode XML entities (e.g. &amp; → &). Do NOT percent-encode '#' — the URI must remain exactly as it was in the XML.
                  const cleanUri = decodeXmlEntities(resMatch[1]);

                  // Filter M3U
                  if (cleanUri.toLowerCase().endsWith('.m3u') || cleanUri.toLowerCase().endsWith('.m3u8')) {
                      continue;
                  }
                  if (itemXml.includes('object.container')) continue;

                  // Re-encode any raw/unsafe characters Browse left un-escaped (see
                  // normalizeUri's doc comment).
                  const uri = normalizeUri(cleanUri);

                  // Reuse the item Browse itself returned (real id/parentID/upnp:class/etc.)
                  // rather than rebuilding a synthetic id="-1" fragment — more faithful to what
                  // the device's own index actually has for this track — but drop its <res>
                  // element (see stripResTag's doc comment for why).
                  const patchedItemXml = stripResTag(patchItemIds(itemXml));
                  const metadata = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                      patchedItemXml + '</DIDL-Lite>';

                  items.push({ uri, metadata, sortKey: uri });
              }
          }

          if (items.length === 0) {
              streamDeck.logger.warn(`${logPrefix} No tracks found.`);
              return false;
          }

          items.sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true, sensitivity: 'base' }));

          streamDeck.logger.info(`${logPrefix} Found ${items.length} sorted tracks. Enqueuing...`);

          await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

          let count = 0;
          for (const item of items) {
              try {
                  await this.sonosDevice.AVTransportService.AddURIToQueue({
                      InstanceID: 0,
                      EnqueuedURI: item.uri,
                      // The SDK only XML-escapes *MetaData fields that are passed as an OBJECT
                      // (via TrackToMetaData) — a string is inserted into the SOAP body verbatim.
                      // Escape it ourselves so it lands as EnqueuedURIMetaData's escaped TEXT
                      // content, not as literal unescaped child elements (see escapeXml's call
                      // site doc comment on why the un-escaped form got UPnPError 402 regardless
                      // of what the DIDL content itself said).
                      EnqueuedURIMetaData: escapeXml(item.metadata),
                      DesiredFirstTrackNumberEnqueued: 0,
                      EnqueueAsNext: false
                  });
              } catch (e) {
                  // The debug level this used to log the URI at is filtered out in production
                  // (plugin.ts sets "info"), so a real failure here previously surfaced only the
                  // bare UPnPError with no way to tell which item/URI/metadata triggered it —
                  // logging at error level, right at the point of failure, so the next occurrence
                  // is actually diagnosable instead of a repeat "guess and retry" cycle.
                  streamDeck.logger.error(`${logPrefix} AddURIToQueue failed for item ${count} — uri=${item.uri}, metadata=${item.metadata}`, e);
                  throw e;
              }
              count++;
          }

          await this.sonosDevice.SwitchToQueue();
          await this.sonosDevice.Play();
          return true;

      } catch (e) {
          streamDeck.logger.error(`${logPrefix} Error processing folder: ${e}`);
          return false;
      }
  }

  async playFavorite(favorite: SonosFavorite): Promise<void> {
    const logPrefix = `[PlayFavorite] [${favorite.Title}]`;
    streamDeck.logger.info(`${logPrefix} START.`);
    
    try {
        // --- 1. SPOTIFY PLAYLIST ---
        if (favorite.TrackUri.includes('spotify:playlist:')) {
            streamDeck.logger.info(`${logPrefix} Spotify Playlist. Using MetadataHelper.`);
            const match = favorite.TrackUri.match(/spotify:playlist:([a-zA-Z0-9]+)/);
            if (match && match[1]) {
                const cleanUri = `spotify:playlist:${match[1]}`;
                const guessedData = MetaDataHelper.GuessMetaDataAndTrackUri(cleanUri);
                
                if (guessedData && guessedData.metadata && guessedData.trackUri) {
                    await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
                    await this.sonosDevice.AVTransportService.AddURIToQueue({
                        InstanceID: 0,
                        EnqueuedURI: guessedData.trackUri,
                        EnqueuedURIMetaData: guessedData.metadata,
                        DesiredFirstTrackNumberEnqueued: 0,
                        EnqueueAsNext: false
                    });
                    await this.sonosDevice.SwitchToQueue();
                    await this.sonosDevice.Play();
                    streamDeck.logger.info(`${logPrefix} SUCCESS (Spotify).`);
                    return;
                }
            }
        }

        // --- 2. MUSIC LIBRARY / NAS FOLDER ---
        if (favorite.TrackUri.startsWith('x-rincon-playlist') || favorite.TrackUri.startsWith('x-file-cifs')) {
            streamDeck.logger.info(`${logPrefix} Music Library/Folder detected. Trying custom expansion.`);
            
            const success = await this.handleLocalFolder(favorite);
            
            if (success) {
                streamDeck.logger.info(`${logPrefix} SUCCESS (Music Library Custom).`);
                return;
            }

            // FALLBACK
            streamDeck.logger.warn(`${logPrefix} Custom expansion failed. Fallback to native Container Queueing.`);
            await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

            // Same raw-space issue as handleLocalFolder's tracks (see normalizeUri) can appear in
            // the folder-container reference itself — normalize only the part after '#' (the
            // share/object path), leaving the "x-rincon-playlist:RINCON_..." prefix untouched.
            const hashIndex = favorite.TrackUri.indexOf('#');
            const trackUri = hashIndex > -1
                ? favorite.TrackUri.slice(0, hashIndex + 1) + normalizeUri(favorite.TrackUri.slice(hashIndex + 1))
                : normalizeUri(favorite.TrackUri);
            const containerId = hashIndex > -1 ? normalizeUri(favorite.TrackUri.slice(hashIndex + 1)) : favorite.ItemId;

            // No <res> element — see stripResTag's doc comment; EnqueuedURI already carries the
            // resource location as a separate top-level SOAP field.
            const metadata =
                '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                `<item id="${escapeXml(containerId ?? '')}" parentID="${escapeXml(favorite.ParentId ?? '')}" restricted="true">` +
                `<dc:title>${escapeXml(favorite.Title)}</dc:title>` +
                `<upnp:class>object.container.playlistContainer</upnp:class>` +
                `</item></DIDL-Lite>`;

            try {
                await this.sonosDevice.AVTransportService.AddURIToQueue({
                    InstanceID: 0,
                    EnqueuedURI: trackUri,
                    // See handleLocalFolder's identical escapeXml call for why a string
                    // EnqueuedURIMetaData must be escaped ourselves before it goes out.
                    EnqueuedURIMetaData: escapeXml(metadata),
                    DesiredFirstTrackNumberEnqueued: 0,
                    EnqueueAsNext: false
                });
            } catch (e) {
                // Same diagnosability gap as handleLocalFolder's per-item log — surface exactly
                // what was sent, not just the bare UPnPError, so a repeat failure is diagnosable.
                streamDeck.logger.error(`${logPrefix} AddURIToQueue (fallback) failed — containerId=${containerId}, trackUri=${trackUri}, protocolInfo=${favorite.ProtocolInfo}, metadata=${metadata}`, e);
                throw e;
            }

            await this.sonosDevice.SwitchToQueue();
            await this.sonosDevice.Play();
            streamDeck.logger.info(`${logPrefix} SUCCESS (Music Library Fallback).`);
            return;
        }

        // --- 3. RADIO / DIRECT URI ---
        // Use the r:resMD field from the raw Browse response as CurrentURIMetaData.
        // r:resMD is pre-HTML-encoded DIDL-Lite with the correct id, upnp:class, and cdudn.
        // Passing it as a string bypasses TrackToMetaData, which corrupts UpnpClass when the
        // SDK parses two <upnp:class> elements and concatenates them (causing UPnP 402).
        const resMd = sonosFavoritesCache.getResMd(favorite.TrackUri);
        streamDeck.logger.info(`${logPrefix} Standard/Radio detected. URI="${favorite.TrackUri}"`);

        await this.sonosDevice.AVTransportService.SetAVTransportURI({
            InstanceID: 0,
            CurrentURI: favorite.TrackUri,
            // resMd is the raw pre-encoded DIDL string; the object fallback relies on the
            // lib's TrackToMetaData shim, hence the cast.
            CurrentURIMetaData: resMd ?? ({ ...favorite } as unknown as string),
        });

        await this.sonosDevice.Play();
        streamDeck.logger.info(`${logPrefix} SUCCESS (Radio).`);

    } catch (error: any) {
        streamDeck.logger.error(`${logPrefix} ERROR: ${error}`);
        throw error;
    }
  }
}
