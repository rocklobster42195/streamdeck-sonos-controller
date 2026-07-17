import streamDeck from "@elgato/streamdeck";
import { SonosDevice, MetaDataHelper } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./sonos-discovery";
import { SonosFavorite } from "./SonosTypes";
import { escapeXml, decodeXmlEntities } from "../utils/xml";

/**
 * Plays a Sonos favorite on one device, dispatching on the favorite's URI type (Spotify
 * playlist / music-library folder / radio-direct URI) — extracted verbatim from
 * SonosDeviceController, which now only delegates. Owns all DIDL-Lite metadata building and
 * the custom NAS-folder expansion. Deliberately targets the given device directly (not the
 * group coordinator): Sonos routes queue/transport changes correctly from any member here.
 */
export class SonosFavoritePlayer {
  constructor(private readonly sonosDevice: SonosDevice) {}

  // --- Helper Methods ---
  private generateMetadata(title: string, uri: string, upnpClass: string, protocolInfo: string): string {
    // ID -1 signals Sonos that this is a new item to add to the queue.
    return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
        `<item id="-1" parentID="-1" restricted="true">` +
        `<dc:title>${escapeXml(title)}</dc:title>` +
        `<upnp:class>${upnpClass}</upnp:class>` +
        `<res protocolInfo="${protocolInfo}">${escapeXml(uri)}</res>` +
        `</item></DIDL-Lite>`;
  }

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
              title: string;
              protocolInfo: string;
              sortKey: string;
          }

          const items: FolderTrack[] = [];
          const itemRegex = /<item[\s\S]*?<\/item>/g;
          let itemMatch;
          
          while ((itemMatch = itemRegex.exec(result.Result)) !== null) {
              const itemXml = itemMatch[0];
              const resMatch = itemXml.match(/<res[^>]*>(.*?)<\/res>/);
              const titleMatch = itemXml.match(/<dc:title>(.*?)<\/dc:title>/);
              
              if (resMatch && resMatch[1]) {
                  const rawUriFromXml = resMatch[1];
                  
                  // Decode XML entities (e.g. &amp; → &). Do NOT percent-encode '#' — the URI must remain exactly as it was in the XML.
                  const cleanUri = decodeXmlEntities(rawUriFromXml);
                  
                  const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : "Track";
                  
                  let protocolInfo = "x-file-cifs:*:audio/mpeg:*";
                  const resTagFull = itemXml.match(/<res([^>]*)>/);
                  if (resTagFull && resTagFull[1]) {
                      const protoMatch = resTagFull[1].match(/protocolInfo="([^"]*)"/);
                      if (protoMatch && protoMatch[1]) {
                          protocolInfo = protoMatch[1];
                      }
                  }

                  // Filter M3U
                  if (cleanUri.toLowerCase().endsWith('.m3u') || cleanUri.toLowerCase().endsWith('.m3u8')) {
                      continue;
                  }
                  
                  if (!itemXml.includes('object.container')) {
                      items.push({ 
                          uri: cleanUri, 
                          title: title,
                          protocolInfo: protocolInfo,
                          sortKey: cleanUri 
                      });
                  }
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
              const metadata = this.generateMetadata(
                  item.title, 
                  item.uri, 
                  'object.item.audioItem.musicTrack', 
                  item.protocolInfo
              );

              if (count === 0) {
                  streamDeck.logger.debug(`${logPrefix} First Track URI: ${item.uri}`);
              }

              await this.sonosDevice.AVTransportService.AddURIToQueue({
                  InstanceID: 0,
                  EnqueuedURI: item.uri, 
                  EnqueuedURIMetaData: metadata,
                  DesiredFirstTrackNumberEnqueued: 0,
                  EnqueueAsNext: false
              });
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

            let containerId = favorite.ItemId;
            const hashIndex = favorite.TrackUri.indexOf('#');
            if (hashIndex > -1) {
                containerId = favorite.TrackUri.substring(hashIndex + 1);
            }

            const metadata =
                '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                `<item id="${containerId}" parentID="${favorite.ParentId}" restricted="true">` +
                `<dc:title>${escapeXml(favorite.Title)}</dc:title>` +
                `<upnp:class>object.container.playlistContainer</upnp:class>` + 
                `<res protocolInfo="${favorite.ProtocolInfo}">${escapeXml(favorite.TrackUri)}</res>` +
                `</item></DIDL-Lite>`;

            await this.sonosDevice.AVTransportService.AddURIToQueue({
                InstanceID: 0,
                EnqueuedURI: favorite.TrackUri,
                EnqueuedURIMetaData: metadata,
                DesiredFirstTrackNumberEnqueued: 0,
                EnqueueAsNext: false
            });

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
