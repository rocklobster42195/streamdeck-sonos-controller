import streamDeck from "@elgato/streamdeck";
import { SonosDevice, SonosEvents, ServiceEvents, MetaDataHelper } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./sonos-discovery";

import { Track } from "@svrooij/sonos/lib/models";
import { loadImageFromUri } from "./utils";
import { GetZoneAttributesResponse } from "@svrooij/sonos/lib/services";
import { SonosZoneGroupStates, TrackInfo, VolumeInfo } from "./SonosTypes";

export class SonosDeviceController {
  public readonly deviceIp: string;
  public sonosDevice: SonosDevice; 

  private volumeInfoCallbacks: Map<string, (volumeInfo: VolumeInfo) => void> = new Map();
  private transportStateCallbacks: Map<string, (transportState: string) => void> = new Map();
  private playModeCallbacks: Map<string, (playMode: string) => void> = new Map();
  private trackInfoCallbacks: Map<string, (trackInfo: TrackInfo) => void> = new Map();
  
  private refreshInterval?: NodeJS.Timeout;
  private pollInterval?: NodeJS.Timeout;
  private lastPolledTransportState = '';
  private isInitialized = false;

  // Internal state
  private currentVolume: number = 0;
  private currentMute: boolean = false;
  private currentAlbumArtUri: string = '';
  private currentTrack: TrackInfo | undefined;
  // Only ever set when a cover is successfully loaded; never cleared by track events with no art.
  private lastKnownCover: string | undefined;

  static isRadioStream(uri: string | undefined): boolean {
    if (!uri) return false;
    return uri.startsWith('x-sonosapi-stream:') ||
           uri.startsWith('x-sonosapi-radio:')  ||
           uri.startsWith('x-sonosapi-hls:')    ||
           uri.startsWith('x-rincon-stream:')   ||
           uri.startsWith('aac:')               ||
           uri.startsWith('pndrradio:')         ||
           // Sonos Radio (Deezer-powered) delivers individual tracks via x-sonos-http but they are not skippable.
           (uri.startsWith('x-sonos-http:') && uri.includes('-DZR:'));
  }

  private static isRadioAlbumArtUri(albumArtUri: string | undefined): boolean {
    if (!albumArtUri) return false;
    // Sonos Radio (Deezer-powered) serves cover art from sonosradio.imgix.net — no u= parameter.
    if (albumArtUri.includes('sonosradio.imgix.net')) return true;
    const match = albumArtUri.match(/[?&]u=([^&]+)/);
    if (!match) return false;
    return SonosDeviceController.isRadioStream(decodeURIComponent(match[1]));
  }

  constructor(deviceIp: string) {
    this.deviceIp = deviceIp;
    this.sonosDevice = new SonosDevice(deviceIp);
    streamDeck.logger.debug(`SonosDeviceController for ${this.deviceIp} created.`);
  }

  // --- Init & Destroy ---
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.updateInitialState();
    await this.initializeSubscriptions();
    // Always poll — catches missed UPnP events (e.g. lost PLAYING after TRANSITIONING).
    this.startPolling();
    this.startRefreshEventSubscriptions();
    this.isInitialized = true;
  }
  public destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.cancelSubscriptions();
    this.volumeInfoCallbacks.clear();
    this.transportStateCallbacks.clear();
    this.playModeCallbacks.clear();
    this.trackInfoCallbacks.clear();
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    let trackPollTick = 0;
    this.pollInterval = setInterval(async () => {
      try {
        const [tsInfo, volInfo, muteInfo] = await Promise.all([
          this.sonosDevice.AVTransportService.GetTransportInfo({ InstanceID: 0 }),
          this.sonosDevice.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' }),
          this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' }),
        ]);

        const ts = tsInfo.CurrentTransportState;
        if (ts !== this.lastPolledTransportState) {
          this.lastPolledTransportState = ts;
          this.transportStateCallbacks.forEach(cb => cb(ts));
        }

        const newVol = volInfo.CurrentVolume;
        const newMute = muteInfo.CurrentMute;
        if (newVol !== this.currentVolume || newMute !== this.currentMute) {
          this.currentVolume = newVol;
          this.currentMute = newMute;
          this.volumeInfoCallbacks.forEach(cb => cb({ volume: newVol, mute: newMute }));
        }

        // Poll track info every 3rd tick (~15 s) when playing — covers UPnP-dead scenarios.
        trackPollTick++;
        if (trackPollTick % 3 === 0 && ts === 'PLAYING') {
          const track = await this.getCurrentTrack();
          if (track && track.Title !== this.currentTrack?.Title) {
            const newTrackInfo: TrackInfo = { ...track };
            if (track.AlbumArtUri && track.AlbumArtUri !== this.currentAlbumArtUri) {
              this.currentAlbumArtUri = track.AlbumArtUri;
              try {
                const cover = await loadImageFromUri(track.AlbumArtUri, this.sonosDevice);
                if (cover) { newTrackInfo.albumArtDataUri = cover; this.lastKnownCover = cover; }
              } catch { this.currentAlbumArtUri = ''; }
            }
            newTrackInfo.albumArtDataUri = newTrackInfo.albumArtDataUri ?? this.lastKnownCover;
            newTrackInfo.isRadio =
              SonosDeviceController.isRadioStream(track.TrackUri) ||
              (track.AlbumArtUri
                ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri)
                : (this.currentTrack?.isRadio ?? false));
            this.currentTrack = newTrackInfo;
            this.trackInfoCallbacks.forEach(cb => cb(this.currentTrack!));
          }
        }
      } catch (e) {
        streamDeck.logger.debug(`[${this.deviceIp}] Polling error:`, e);
      }
    }, 8000);
  }

  private async updateInitialState(): Promise<void> {
    const volume = await this.sonosDevice.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
    this.currentVolume = volume.CurrentVolume;

    const mute = await this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' });
    this.currentMute = mute.CurrentMute;

    const track = await this.getCurrentTrack();
    if (track) {
        this.currentTrack = track;
        this.currentTrack.isRadio =
            SonosDeviceController.isRadioStream(track.TrackUri) ||
            (track.AlbumArtUri ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri) : false);
        if (track.AlbumArtUri) {
            const cover = await loadImageFromUri(track.AlbumArtUri, this.sonosDevice);
            if (cover) this.currentTrack.albumArtDataUri = cover;
        }
    }
  }

  // --- Basic Controls ---
  async togglePlayPause(): Promise<void> { this.sonosDevice.TogglePlayback(); }
  async next(): Promise<void> { await this.sonosDevice.Next(); }
  async previous(): Promise<void> { await this.sonosDevice.Previous(); }
  
  async setVolume(volume: number): Promise<void> {
    await this.sonosDevice.RenderingControlService.SetVolume({ DesiredVolume: volume, InstanceID: 0, Channel: "Master" });
  }

  async volumeUp(step: number = 2): Promise<void> {
    const newVolume = Math.min(100, this.currentVolume + step);
    await this.setVolume(newVolume);
  }
  
  async volumeDown(step: number = 2): Promise<void> {
    const newVolume = Math.max(0, this.currentVolume - step);
    await this.setVolume(newVolume);
  }

  async toggleShuffle(): Promise<void> {
    const { PlayMode: currentMode } = await this.sonosDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    const mode = String(currentMode);
    let desiredNext: string;

    switch (mode) {
      case 'NORMAL':
        desiredNext = 'SHUFFLE_NOREPEAT';
        break;
      case 'REPEAT_ALL':
        desiredNext = 'SHUFFLE';
        break;
      case 'REPEAT_ONE':
        desiredNext = 'SHUFFLE_REPEAT_ONE';
        break;
      case 'SHUFFLE_NOREPEAT':
        desiredNext = 'NORMAL';
        break;
      case 'SHUFFLE':
      case 'SHUFFLE_REPEAT_ALL':
        desiredNext = 'REPEAT_ALL';
        break;
      case 'SHUFFLE_REPEAT_ONE':
        desiredNext = 'REPEAT_ONE';
        break;
      default:
        desiredNext = 'SHUFFLE_NOREPEAT';
    }

    const candidates: string[] = [desiredNext];
    if (desiredNext.includes('SHUFFLE') && desiredNext !== 'SHUFFLE_NOREPEAT') {
        candidates.push('SHUFFLE_NOREPEAT');
    }
    if (!desiredNext.includes('SHUFFLE') && desiredNext !== 'NORMAL') {
        candidates.push('NORMAL');
    }

    streamDeck.logger.debug(`[toggleShuffle] current=${mode}, desiredNext=${desiredNext}, candidates=${candidates.join(',')}`);

    let lastError: any = null;
    for (const candidate of candidates) {
      try {
        await this.sonosDevice.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: candidate as any });
        streamDeck.logger.info(`[toggleShuffle] SetPlayMode succeeded: ${candidate}`);
        try {
            const actual = await this.getPlayMode();
            this.playModeCallbacks.forEach(cb => cb(actual));
        } catch (e) {
            this.playModeCallbacks.forEach(cb => cb(candidate));
        }
        return;
      } catch (err) {
        lastError = err;
        streamDeck.logger.warn(`[toggleShuffle] SetPlayMode ${candidate} failed:`, err);
        continue;
      }
    }
    streamDeck.logger.error('[toggleShuffle] All candidate play modes failed', lastError);
    throw lastError;
  }

  async toggleRepeat(): Promise<void> {
    const { PlayMode: currentMode } = await this.sonosDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    const mode = String(currentMode);

    // Determine the desired next mode in a predictable rotation
    let desiredNext: string;
    switch (mode) {
      case 'NORMAL':
        desiredNext = 'REPEAT_ALL';
        break;
      case 'REPEAT_ALL':
        desiredNext = 'REPEAT_ONE';
        break;
      case 'REPEAT_ONE':
        desiredNext = 'NORMAL';
        break;
      case 'SHUFFLE_NOREPEAT':
        desiredNext = 'SHUFFLE';
        break;
      case 'SHUFFLE':
      case 'SHUFFLE_REPEAT_ALL':
        desiredNext = 'SHUFFLE_REPEAT_ONE';
        break;
      case 'SHUFFLE_REPEAT_ONE':
        desiredNext = 'SHUFFLE_NOREPEAT';
        break;
      default:
        desiredNext = 'REPEAT_ALL';
    }

    // Build fallback list: try desiredNext first, then reasonable fallbacks
    const candidates: string[] = [desiredNext];
    // If user toggles to a shuffle variant but device doesn't support, allow falling back
    if (desiredNext.includes('SHUFFLE')) {
      let normalEquivalent = desiredNext === 'SHUFFLE' ? 'REPEAT_ALL' : desiredNext.replace('SHUFFLE_', '');
      if (normalEquivalent === 'NOREPEAT') normalEquivalent = 'NORMAL';
      candidates.push(normalEquivalent);
      // also try other repeat modes
      candidates.push('REPEAT_ONE', 'REPEAT_ALL', 'NORMAL');
    } else {
      // Non-shuffle desired: also try other repeat states
      candidates.push('REPEAT_ONE', 'REPEAT_ALL', 'NORMAL');
      // also try shuffle equivalents
      candidates.push('SHUFFLE_NOREPEAT', 'SHUFFLE_REPEAT_ALL', 'SHUFFLE_REPEAT_ONE');
    }

    streamDeck.logger.debug(`[toggleRepeat] current=${mode}, desiredNext=${desiredNext}, candidates=${candidates.join(',')}`);

    let lastError: any = null;
    for (const candidate of candidates) {
      try {
        await this.sonosDevice.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: candidate as any });
        streamDeck.logger.info(`[toggleRepeat] SetPlayMode succeeded: ${candidate}`);
        try {
          const actual = await this.getPlayMode();
          streamDeck.logger.debug(`[toggleRepeat] Device returned playMode=${actual}`);
          this.playModeCallbacks.forEach(cb => cb(actual));
        } catch (e) {
          streamDeck.logger.warn('[toggleRepeat] Failed to read back playMode, using candidate for UI', e);
          this.playModeCallbacks.forEach(cb => cb(candidate));
        }
        return;
      } catch (err) {
        lastError = err;
        streamDeck.logger.warn(`[toggleRepeat] SetPlayMode ${candidate} failed, trying next:`, (err && (err as any).message) ?? err);
        continue;
      }
    }

    streamDeck.logger.error('[toggleRepeat] All candidate play modes failed', lastError);
    throw lastError;
  }

  async toggleMute(): Promise<boolean> {
    const newMute = !this.currentMute;
    await this.sonosDevice.RenderingControlService.SetMute({ DesiredMute: newMute, InstanceID: 0, Channel: "Master" });
    return newMute;
  }
  
  async getVolume(): Promise<VolumeInfo> {
    return { volume: this.currentVolume, mute: this.currentMute };
  }

  // --- Getters ---
  async getTransportState(): Promise<string> {
    const transportInfo = await this.sonosDevice.AVTransportService.GetTransportInfo({ InstanceID: 0 });
    return transportInfo.CurrentTransportState;
  }
  async getPlayMode(): Promise<string> {
    const settings = await this.sonosDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    return settings.PlayMode;
  }
  async isMuted(): Promise<boolean> {
    let mute = await this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: "Master" });
    return mute.CurrentMute;
  }

  // --- Callbacks ---
  registerVolumeCallback(id: string, callback: (volumeInfo: VolumeInfo) => void): void { this.volumeInfoCallbacks.set(id, callback); }
  unregisterVolumeCallback(id: string): void { this.volumeInfoCallbacks.delete(id); }
  registerTransportStateCallback(id: string, callback: (transportState: string) => void): void { this.transportStateCallbacks.set(id, callback); }
  unregisterTransportStateCallback(id: string): void { this.transportStateCallbacks.delete(id); }
  registerPlayModeCallback(id: string, callback: (playMode: string) => void): void { this.playModeCallbacks.set(id, callback); }
  unregisterPlayModeCallback(id: string): void { this.playModeCallbacks.delete(id); }
  registerTrackInfoCallback(id: string, callback: (trackInfo: TrackInfo) => void): void {
    this.trackInfoCallbacks.set(id, callback);
    // Fire immediately with cached state so callers get isRadio without waiting for the next UPnP event.
    if (this.currentTrack) callback(this.currentTrack);
  }
  unregisterTrackInfoCallback(id: string): void { this.trackInfoCallbacks.delete(id); }
  
  // --- Subscriptions ---
  async cancelSubscriptions(): Promise<void> { await this.sonosDevice.CancelEvents(); }
  
  async initializeSubscriptions(): Promise<void> {
    try {
      this.sonosDevice.Events.on(SonosEvents.SubscriptionError, (err) => {
        streamDeck.logger.error("Subscribe error", err);
        if (!this.pollInterval) {
          streamDeck.logger.warn(`[${this.deviceIp}] UPnP subscription failed — falling back to 5s polling.`);
          this.startPolling();
        }
      });
      
      this.sonosDevice.AVTransportService.Events.on(ServiceEvents.ServiceEvent, (data: any) => {
          try {
            const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : String(data);
            streamDeck.logger.debug(`[AVTransportService Event] keys=${keys}`);
          } catch (e) { /* ignore logging errors */ }
          if (typeof data.TransportState === 'string') this.transportStateCallbacks.forEach(cb => cb(data.TransportState));
          if (typeof data.CurrentPlayMode === 'string') this.playModeCallbacks.forEach(cb => cb(data.CurrentPlayMode));
          // Some devices may emit 'PlayMode' instead of 'CurrentPlayMode'
          if (typeof data.PlayMode === 'string') this.playModeCallbacks.forEach(cb => cb(data.PlayMode));
      });
      
      this.sonosDevice.RenderingControlService.Events.on(ServiceEvents.ServiceEvent, (data: any) => {
          let stateChanged = false;
          if (data.Volume && typeof data.Volume.Master === 'number' && data.Volume.Master !== this.currentVolume) {
              this.currentVolume = data.Volume.Master;
              stateChanged = true;
          }
          if (data.Mute && typeof data.Mute.Master === 'boolean' && data.Mute.Master !== this.currentMute) {
              this.currentMute = data.Mute.Master;
              stateChanged = true;
          }

          if (stateChanged) {
              this.volumeInfoCallbacks.forEach(cb => cb({ volume: this.currentVolume, mute: this.currentMute }));
          }
      });

      this.sonosDevice.Events.on('currentTrack', async (track: Track) => {
        streamDeck.logger.debug(`Current track changed: "${track.Title}", AlbumArtUri="${track.AlbumArtUri || "none"}"`);
        
        const newTrackInfo: TrackInfo = track;

        if (track.AlbumArtUri && track.AlbumArtUri !== this.currentAlbumArtUri) {
            this.currentAlbumArtUri = track.AlbumArtUri;
            try {
                const cover = await loadImageFromUri(track.AlbumArtUri, this.sonosDevice);
                if (cover) {
                    newTrackInfo.albumArtDataUri = cover;
                    this.lastKnownCover = cover;
                }
            } catch (err) {
                streamDeck.logger.error("Error loading cover art", err);
                this.currentAlbumArtUri = ''; // Reset on error
            }
        } else if (!track.AlbumArtUri) {
            this.currentAlbumArtUri = '';
        }

        // Preserve the last known cover so news segments (which have no art) keep showing the station logo.
        newTrackInfo.albumArtDataUri = newTrackInfo.albumArtDataUri || this.currentTrack?.albumArtDataUri || this.lastKnownCover;
        // Preserve isRadio across news segments (which fire with no AlbumArtUri).
        // TrackUri is the primary signal (always carries the radio stream scheme).
        // Fall back to AlbumArtUri-based detection, then preserve previous state for news segments.
        newTrackInfo.isRadio =
            SonosDeviceController.isRadioStream(track.TrackUri) ||
            (track.AlbumArtUri
                ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri)
                : (this.currentTrack?.isRadio ?? false));
        this.currentTrack = newTrackInfo;
        this.trackInfoCallbacks.forEach(cb => cb(this.currentTrack!));
      });
    } catch (error) { streamDeck.logger.error("Error initializing subscriptions", error); }
  }
  
  private startRefreshEventSubscriptions(): void {
    this.refreshInterval = setInterval(async () => {
      try { await this.sonosDevice.RefreshEventSubscriptions(); } catch (e) { streamDeck.logger.error(`Error refreshing Sonos event subscriptions:`, e); }
    }, 300 * 1000);
  }
  
  // The rest of the methods (playFavorite, helpers, etc.) are omitted for brevity but remain unchanged.
  // ...
  // --- Helper Methods ---
  private encodeXml(str: string): string {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  
  private decodeXmlEntities(str: string): string {
    if (typeof str !== 'string') return '';
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  private generateMetadata(title: string, uri: string, upnpClass: string, protocolInfo: string): string {
    // ID -1 signals Sonos that this is a new item to add to the queue.
    return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
        `<item id="-1" parentID="-1" restricted="true">` +
        `<dc:title>${this.encodeXml(title)}</dc:title>` +
        `<upnp:class>${upnpClass}</upnp:class>` +
        `<res protocolInfo="${protocolInfo}">${this.encodeXml(uri)}</res>` +
        `</item></DIDL-Lite>`;
  }

  private async handleLocalFolder(favorite: any): Promise<boolean> {
      const logPrefix = `[LocalFolder]`;
      streamDeck.logger.info(`${logPrefix} Browsing folder content...`);

      try {
          let result: any = null;
          
          try {
             result = await this.sonosDevice.ContentDirectoryService.Browse({
                ObjectID: favorite.ItemId,
                BrowseFlag: 'BrowseDirectChildren',
                Filter: '*',
                StartingIndex: 0,
                RequestedCount: 1000, 
                SortCriteria: ''
             });
          } catch(e) { /* ignore */ }

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
                   } catch (e2) {
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
                       } catch(e3) { /* ignore */ }
                   }
               }
          }

          if (!result || typeof result.Result !== 'string') {
              streamDeck.logger.warn(`${logPrefix} No XML result.`);
              return false;
          }

          interface TrackInfo {
              uri: string;
              title: string;
              protocolInfo: string;
              sortKey: string;
          }
          
          const items: TrackInfo[] = [];
          const itemRegex = /<item[\s\S]*?<\/item>/g;
          let itemMatch;
          
          while ((itemMatch = itemRegex.exec(result.Result)) !== null) {
              const itemXml = itemMatch[0];
              const resMatch = itemXml.match(/<res[^>]*>(.*?)<\/res>/);
              const titleMatch = itemXml.match(/<dc:title>(.*?)<\/dc:title>/);
              
              if (resMatch && resMatch[1]) {
                  const rawUriFromXml = resMatch[1];
                  
                  // Decode XML entities (e.g. &amp; → &). Do NOT percent-encode '#' — the URI must remain exactly as it was in the XML.
                  const cleanUri = this.decodeXmlEntities(rawUriFromXml);
                  
                  const title = titleMatch ? this.decodeXmlEntities(titleMatch[1]) : "Track";
                  
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

  // --- Main Logic: Play Favorite ---

  async playFavorite(favorite: any): Promise<void> {
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
                `<dc:title>${this.encodeXml(favorite.Title)}</dc:title>` +
                `<upnp:class>object.container.playlistContainer</upnp:class>` + 
                `<res protocolInfo="${favorite.ProtocolInfo}">${this.encodeXml(favorite.TrackUri)}</res>` +
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
            CurrentURIMetaData: resMd ?? { ...favorite },
        });

        await this.sonosDevice.Play();
        streamDeck.logger.info(`${logPrefix} SUCCESS (Radio).`);

    } catch (error: any) {
        streamDeck.logger.error(`${logPrefix} ERROR: ${error}`);
        throw error;
    }
  }


  async getCurrentTrackCover(): Promise<string | undefined> {
      const positionInfo = await this.sonosDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
      const trackMetadata = positionInfo.TrackMetaData;

      streamDeck.logger.debug(`[getCurrentTrackCover] TrackURI="${positionInfo.TrackURI}", metadataType=${typeof trackMetadata}`);

      // Queue playback: metadata is parsed and contains AlbumArtUri.
      if (typeof trackMetadata !== 'string' && trackMetadata.AlbumArtUri) {
          return await loadImageFromUri(trackMetadata.AlbumArtUri, this.sonosDevice);
      }

      // Radio / streaming: derive the art from the stream URI via the Sonos /getaa endpoint.
      // This works regardless of whether TrackMetaData is a plain string (some radio) or a
      // parsed object without AlbumArtUri (other radio). The URI stays stable during news
      // segments, so the station logo keeps showing.
      if (positionInfo.TrackURI) {
          const artUri = `/getaa?s=1&u=${encodeURIComponent(positionInfo.TrackURI)}`;
          streamDeck.logger.debug(`[getCurrentTrackCover] Trying radio art: ${artUri.substring(0, 80)}`);
          const cover = await loadImageFromUri(artUri, this.sonosDevice);
          if (cover) return cover;
      }

      // Buffered cover — set during UPnP track events; news events preserve the previous cover.
      if (this.currentTrack?.albumArtDataUri) return this.currentTrack.albumArtDataUri;

      // Final fallback: last cover that was ever successfully loaded for this device.
      return this.lastKnownCover;
  }
  async getCurrentTrack(): Promise<Track | undefined> {
    const positionInfo = await this.sonosDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
    const trackMetadata = positionInfo.TrackMetaData;
    if (typeof trackMetadata !== 'string') return trackMetadata;
    return undefined;
  }
  
  async getZoneAttributes(debug?: boolean): Promise<GetZoneAttributesResponse> {
    const zoneAttributes = await this.sonosDevice.DevicePropertiesService.GetZoneAttributes();
    if (debug) streamDeck.logger.debug(zoneAttributes);
    return zoneAttributes;
  }
  async getZoneGroupState(debug?: boolean): Promise<SonosZoneGroupStates> {
    const zoneGroupState = await this.sonosDevice.GetZoneGroupState();
    if (debug) streamDeck.logger.debug(zoneGroupState);
    return zoneGroupState as SonosZoneGroupStates;
  }
  async getFavorites(debug?: boolean): Promise<any> {
    const favorites = this.sonosDevice.GetFavoriteRadioStations();
    if (debug) streamDeck.logger.debug(favorites);
    return favorites;
  }
}
