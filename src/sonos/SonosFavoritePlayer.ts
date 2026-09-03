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
 * playlist / music-library folder / streaming-service container / radio-direct URI) — extracted
 * verbatim from SonosDeviceController, which now only delegates. Owns all DIDL-Lite metadata
 * building and the custom NAS-folder expansion.
 *
 * `resolveDevice` MUST return the group COORDINATOR (SonosDeviceController.transportDevice does
 * this). Queue operations — RemoveAllTracksFromQueue / AddURIToQueue / SwitchToQueue — are
 * rejected with `UPnPError 800 (Command not supported or not a coordinator)` when sent to a
 * grouped non-coordinator member; the earlier "any member works" assumption here was wrong and
 * caused intermittent favorite failures whenever the target speaker happened to be grouped
 * under another (hardware-confirmed via a user log, 2026-09-03). Resolved per call, not cached,
 * because groups reform at any time.
 */
export class SonosFavoritePlayer {
  constructor(private readonly resolveDevice: () => SonosDevice) {}

  private async handleLocalFolder(favorite: SonosFavorite): Promise<boolean> {
      const logPrefix = `[LocalFolder]`;
      streamDeck.logger.info(`${logPrefix} Browsing folder content...`);

      // Group coordinator — Browse can be read from any member, but the queue writes below
      // (RemoveAllTracksFromQueue / AddURIToQueue / SwitchToQueue) must go to the coordinator.
      const device = this.resolveDevice();

      try {
          let result: any = null;

          try {
             result = await device.ContentDirectoryService.Browse({
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
                       result = await device.ContentDirectoryService.Browse({
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
                           result = await device.ContentDirectoryService.Browse({
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

          await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

          let count = 0;
          for (const item of items) {
              try {
                  await device.AVTransportService.AddURIToQueue({
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

          await device.SwitchToQueue();
          await device.Play();
          return true;

      } catch (e) {
          streamDeck.logger.error(`${logPrefix} Error processing folder: ${e}`);
          return false;
      }
  }

  /**
   * Best-effort playback for a favorite that arrived with no <res>/TrackUri — only <r:resMD>
   * (TIDAL artist/track radio, flow, some service playlists). We can't call the music service's
   * own getMetadata, so: (1) log the full favorite shape at ERROR level so a real occurrence is
   * diagnosable in one shot; (2) normalise the resMD (Sonos writes slashes in some service item
   * ids as the literal token `__UNENCODED_SLASH__` — confirmed with a TIDAL "Artist Radio"
   * favorite, id `10082064artists__UNENCODED_SLASH__3717340__UNENCODED_SLASH__radio`); (3) derive
   * a URI from the resMD's inner <item id="…"> — already-schemed → as-is, otherwise
   * x-rincon-cpcontainer:; (4) enqueue, then SetAVTransportURI as fallback, passing the resMD
   * (which carries <desc id="cdudn">) as XML-ESCAPED metadata — favorite.ResMD is decoded DIDL
   * and the SDK inserts a string *MetaData verbatim, so unescaped markup would break the SOAP
   * envelope → UPnPError 402 (seen on the first attempt at this).
   */
  private async playResMdOnlyFavorite(favorite: SonosFavorite, device: SonosDevice, logPrefix: string): Promise<void> {
    const rawResMd = typeof favorite.ResMD === 'string' && favorite.ResMD.length > 0 ? favorite.ResMD : undefined;
    streamDeck.logger.error(
      `${logPrefix} Favorite has no TrackUri (no <res> in FV:2). ItemId=${favorite.ItemId} ` +
      `ParentId=${favorite.ParentId} UpnpClass=${favorite.UpnpClass} ProtocolInfo=${favorite.ProtocolInfo} ` +
      `ResMD=${rawResMd ?? '(none)'}`
    );
    if (!rawResMd) {
      throw new Error('Favorite has neither TrackUri nor ResMD — cannot play.');
    }
    const resMd = rawResMd.replace(/__UNENCODED_SLASH__/g, '/');

    const idMatch = resMd.match(/<item\b[^>]*\bid="([^"]+)"/);
    const rawId = idMatch ? decodeXmlEntities(idMatch[1]) : (favorite.ItemId ?? '');
    if (!rawId || rawId.startsWith('FV:2')) {
      // "FV:2/NN" is the favourites-list entry id, not a playable container id.
      throw new Error(`ResMD has no usable item id ("${rawId}") — cannot derive a play URI.`);
    }
    const uri = /^[a-z][a-z0-9+.-]*:/i.test(rawId) ? rawId : `x-rincon-cpcontainer:${rawId}`;
    const metadata = escapeXml(resMd);
    streamDeck.logger.info(`${logPrefix} ResMD-only favorite — best-effort. derivedUri="${uri}"`);

    try {
      await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
      await device.AVTransportService.AddURIToQueue({
        InstanceID: 0,
        EnqueuedURI: uri,
        EnqueuedURIMetaData: metadata,
        DesiredFirstTrackNumberEnqueued: 0,
        EnqueueAsNext: false,
      });
      await device.SwitchToQueue();
      await device.Play();
      streamDeck.logger.info(`${logPrefix} SUCCESS (ResMD-only enqueue).`);
    } catch (enqueueErr) {
      streamDeck.logger.warn(`${logPrefix} ResMD-only enqueue failed (${enqueueErr}) — trying SetAVTransportURI.`);
      await device.AVTransportService.SetAVTransportURI({ InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: metadata });
      await device.Play();
      streamDeck.logger.info(`${logPrefix} SUCCESS (ResMD-only SetAVTransportURI).`);
    }
  }

  async playFavorite(favorite: SonosFavorite): Promise<void> {
    const logPrefix = `[PlayFavorite] [${favorite.Title}]`;
    streamDeck.logger.info(`${logPrefix} START.`);
    
    try {
        // Group coordinator (see class doc) — every queue/transport call below must target it.
        const device = this.resolveDevice();

        // --- 0. NO <res>/TrackUri — r:resMD-only favorite ---
        // Some favorites (confirmed: TIDAL "track radio"/flow, and certain service playlists) come
        // back from GetFavorites() (FV:2) with NO <res> element. The SDK's ParseDIDLTrack then
        // leaves TrackUri undefined and only populates ResMD. Every branch below assumes a string
        // TrackUri (.includes / .startsWith), so without this guard the whole method throws
        // "Cannot read properties of undefined (reading 'includes')" before any dispatch (seen in
        // a user log 2026-09-03 for a TIDAL "Titanium Radio" favorite).
        if (!favorite.TrackUri) {
            await this.playResMdOnlyFavorite(favorite, device, logPrefix);
            return;
        }

        // --- 1. SPOTIFY PLAYLIST ---
        if (favorite.TrackUri.includes('spotify:playlist:')) {
            streamDeck.logger.info(`${logPrefix} Spotify Playlist. Using MetadataHelper.`);
            const match = favorite.TrackUri.match(/spotify:playlist:([a-zA-Z0-9]+)/);
            if (match && match[1]) {
                const cleanUri = `spotify:playlist:${match[1]}`;
                const guessedData = MetaDataHelper.GuessMetaDataAndTrackUri(cleanUri);
                
                if (guessedData && guessedData.metadata && guessedData.trackUri) {
                    await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
                    await device.AVTransportService.AddURIToQueue({
                        InstanceID: 0,
                        EnqueuedURI: guessedData.trackUri,
                        EnqueuedURIMetaData: guessedData.metadata,
                        DesiredFirstTrackNumberEnqueued: 0,
                        EnqueueAsNext: false
                    });
                    await device.SwitchToQueue();
                    await device.Play();
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
            await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

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
                await device.AVTransportService.AddURIToQueue({
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

            await device.SwitchToQueue();
            await device.Play();
            streamDeck.logger.info(`${logPrefix} SUCCESS (Music Library Fallback).`);
            return;
        }

        // --- 3. STREAMING-SERVICE CONTAINER (Tidal / Amazon / Apple / Deezer / Spotify albums) ---
        // A content-provider *container* URI (x-rincon-cpcontainer:) is a playlist/album, not a
        // playable stream. Handing one to SetAVTransportURI makes Sonos reject it with UPnPError
        // 714 ("Illegal MIME-Type") — the exact reason the Spotify-playlist branch above enqueues
        // instead of setting the transport URI. Route every cpcontainer favorite through the queue,
        // reusing the favorite's own r:resMD as EnqueuedURIMetaData: it is pre-encoded DIDL-Lite
        // that carries the service-specific <desc id="cdudn"> token, which we cannot synthesise for
        // non-Spotify services (GuessMetaDataAndTrackUri only knows Spotify/Deezer/Apple). Without
        // that cached metadata we can't enqueue safely, so fall through to the legacy
        // SetAVTransportURI path unchanged.
        if (favorite.TrackUri.startsWith('x-rincon-cpcontainer:')) {
            const containerMd = sonosFavoritesCache.getResMd(favorite.TrackUri);
            if (containerMd) {
                streamDeck.logger.info(`${logPrefix} Content-provider container detected. Enqueuing via r:resMD.`);
                await device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
                await device.AVTransportService.AddURIToQueue({
                    InstanceID: 0,
                    EnqueuedURI: favorite.TrackUri,
                    // A string *MetaData field is inserted into the SOAP body verbatim (only an
                    // object goes through TrackToMetaData); resMD is already HTML-encoded DIDL,
                    // same as the Spotify path a few lines up and case 4's CurrentURIMetaData.
                    EnqueuedURIMetaData: containerMd,
                    DesiredFirstTrackNumberEnqueued: 0,
                    EnqueueAsNext: false,
                });
                await device.SwitchToQueue();
                await device.Play();
                streamDeck.logger.info(`${logPrefix} SUCCESS (Container Enqueue).`);
                return;
            }
            streamDeck.logger.warn(`${logPrefix} cpcontainer favorite with no cached r:resMD — falling back to SetAVTransportURI.`);
        }

        // --- 4. RADIO / DIRECT URI ---
        // Use the r:resMD field from the raw Browse response as CurrentURIMetaData.
        // r:resMD is pre-HTML-encoded DIDL-Lite with the correct id, upnp:class, and cdudn.
        // Passing it as a string bypasses TrackToMetaData, which corrupts UpnpClass when the
        // SDK parses two <upnp:class> elements and concatenates them (causing UPnP 402).
        const resMd = sonosFavoritesCache.getResMd(favorite.TrackUri);
        streamDeck.logger.info(`${logPrefix} Standard/Radio detected. URI="${favorite.TrackUri}"`);

        await device.AVTransportService.SetAVTransportURI({
            InstanceID: 0,
            CurrentURI: favorite.TrackUri,
            // resMd is the raw pre-encoded DIDL string; the object fallback relies on the
            // lib's TrackToMetaData shim, hence the cast.
            CurrentURIMetaData: resMd ?? ({ ...favorite } as unknown as string),
        });

        try {
            await device.Play();
        } catch (playError: any) {
            // Confirmed on hardware (2026-07-18): Play() issued immediately after
            // SetAVTransportURI can hit the device mid-transition and get rejected with UPnPError
            // 701 ("Transition not available") — SetAVTransportURI itself had already succeeded
            // (the track info/metadata update landed fine), only this follow-up Play() lost the
            // race. One short retry clears it; surfacing this as a hard failure otherwise left the
            // favorite silently not playing with no visible error and no recovery.
            if (playError?.UpnpErrorCode !== 701) throw playError;
            streamDeck.logger.warn(`${logPrefix} Play() hit UPnPError 701 right after SetAVTransportURI — retrying once.`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            await device.Play();
        }
        streamDeck.logger.info(`${logPrefix} SUCCESS (Radio).`);

    } catch (error: any) {
        streamDeck.logger.error(`${logPrefix} ERROR: ${error}`);
        throw error;
    }
  }
}
