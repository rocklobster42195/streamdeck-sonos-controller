
import { SonosDevice, ServiceEvents } from '@svrooij/sonos';
import streamDeck from '@elgato/streamdeck';
import { SonosFavorite } from './SonosTypes';
import { decodeXmlEntities } from '../utils/xml';
import { decodeImage, resizeRGBA } from '../utils/image-decode';
import { encodePngDataUri } from '../utils/png';

/**
 * A cache for Sonos favorites and their scaled cover art.
 * This class is designed as a singleton to be shared across the plugin.
 */
class SonosFavoritesCache {
    // Cache for the system-wide list of favorites.
    private favorites: SonosFavorite[] | null = null;
    private hasFetchedFavorites = false;

    // Pre-encoded DIDL-Lite metadata per favorite ItemId for use in SetAVTransportURI.
    // Extracted verbatim from the raw Browse response so no info (cdudn, res, class) is lost.
    private rawMetadataMap: Map<string, string> = new Map();

    // Cache for scaled cover art images (URL -> base64).
    private coverArtCache: Map<string, string> = new Map();

    // Any device can be used for fetching system-wide favorites.
    private deviceForFetching: SonosDevice | null = null;
    
    // Event handler reference for cleanup.
    private favoritesChangedHandler = (data: any): void => {
        if (data.FavoritesUpdateID) {
            streamDeck.logger.info('Favorites changed event received. Refreshing favorites.');
            this.refreshFavorites();
        }
    };

    /**
     * Starts the automatic refresh mechanism.
     * @param device A Sonos device to be used for future polling.
     */
    public async start(device: SonosDevice): Promise<void> {
        // Idempotent: discovery calls this on every success, and a household switch (manual IP
        // pointing at a different system) re-runs discovery mid-session. Without dropping the old
        // subscription first, favoritesChangedHandler stacks once per re-discovery — each Favorites
        // event then triggers N redundant refreshes.
        this.stop();
        this.deviceForFetching = device;

        // Subscribe to favorites changes.
        this.deviceForFetching.ContentDirectoryService.Events.on(ServiceEvents.ServiceEvent, this.favoritesChangedHandler);
        streamDeck.logger.info('SonosFavoritesCache started and subscribed to favorite changes.');

        // Fetch immediately for the first time and await it to ensure initial data is loaded.
        await this.refreshFavorites();
    }

    /**
     * Stops the automatic refresh mechanism.
     */
    public stop(): void {
        if (this.deviceForFetching) {
            this.deviceForFetching.ContentDirectoryService.Events.off(ServiceEvents.ServiceEvent, this.favoritesChangedHandler);
            this.deviceForFetching = null;
            streamDeck.logger.info('SonosFavoritesCache stopped.');
        }
    }
    
    /**
     * Fetches/refreshes the favorites for the system.
     * Uses the device provided at startup.
     */
    public async refreshFavorites(): Promise<void> {
        if (!this.deviceForFetching) {
            streamDeck.logger.warn('Cannot refresh favorites: no Sonos device available.');
            return;
        }

        try {
            streamDeck.logger.info('Refreshing Sonos favorites...');

            // Raw Browse to extract r:resMD metadata per favorite before the SDK discards it —
            // GetFavorites()/GetFavoriteRadioStations() use BrowseParsedWithDefaults, which loses
            // the r:resMD field. FV:2 = Sonos Favorites; R:0/0 = the separate "My Radio Stations"
            // list (a radio favorite the user saved that never made it into FV:2 — the newer Sonos
            // app splits these; see issue #3). indexResMdFromXml appends, so clear once up front.
            this.rawMetadataMap.clear();
            for (const objectId of ['FV:2', 'R:0/0']) {
                try {
                    const raw = await this.deviceForFetching.ContentDirectoryService.Browse({
                        ObjectID: objectId,
                        BrowseFlag: 'BrowseDirectChildren',
                        Filter: '*',
                        StartingIndex: 0,
                        RequestedCount: 0,
                        SortCriteria: '',
                    });
                    if (typeof raw.Result === 'string') this.indexResMdFromXml(raw.Result);
                } catch (e) {
                    streamDeck.logger.debug(`[FavCache] Raw Browse of ${objectId} failed: ${e}`);
                }
            }
            streamDeck.logger.debug(`[FavCache] Stored r:resMD metadata for ${this.rawMetadataMap.size} favorites.`);

            const favoritesResponse = await this.deviceForFetching.GetFavorites();
            if (Array.isArray(favoritesResponse.Result)) {
                // The lib types Result as Track[]; a favorite carries the same fields we read.
                const all = favoritesResponse.Result as unknown as SonosFavorite[];
                const dropped = all.filter((f) => SonosFavoritesCache.isUnplayableBrowseCategory(f));
                this.favorites = all.filter((f) => !SonosFavoritesCache.isUnplayableBrowseCategory(f));

                // Merge in any "My Radio Stations" (R:0/0) entries that aren't already a favorite.
                const extraRadio = await this.fetchExtraRadioStations(this.favorites);
                if (extraRadio.length > 0) {
                    this.favorites = [...this.favorites, ...extraRadio];
                    streamDeck.logger.info(`Merged ${extraRadio.length} radio station(s) from R:0/0 not in Sonos Favorites: ${extraRadio.map((r) => r.Title).join(', ')}`);
                }

                this.hasFetchedFavorites = true;
                if (dropped.length > 0) {
                    streamDeck.logger.info(`Hiding ${dropped.length} unplayable Sonos browse-category favorite(s): ${dropped.map((f) => f.Title).join(', ')}`);
                }
                streamDeck.logger.info(`Successfully cached ${this.favorites.length} favorites.`);

                // Asynchronously process cover art and wait for it to complete.
                await this.processCoverArts(this.favorites);
            } else {
                this.favorites = [];
                this.hasFetchedFavorites = true;
                streamDeck.logger.warn('Received unexpected non-array response for favorites, or no favorites found.');
            }
        } catch (error) {
            streamDeck.logger.error('Failed to refresh Sonos favorites:', error);
            // Don't reset hasFetchedFavorites, to avoid constant retries on network errors.
            // The periodic refresh will try again later.
        }
    }

    // Parse a raw ContentDirectory Browse result and record each item's <r:resMD> (the already
    // HTML-encoded DIDL-Lite SetAVTransportURI/AddURIToQueue want, kept verbatim to bypass
    // TrackToMetaData) keyed by its canonical <res> TrackUri. Appends to rawMetadataMap.
    private indexResMdFromXml(xml: string): void {
        const itemRe = /<item[\s\S]*?<\/item>/g;
        // r:resMD text has no actual '<' chars (content is HTML-encoded), so [^<]* is safe.
        const resMdRe = /<r:resMD>([^<]+)<\/r:resMD>/;
        // <res> URI is XML-entity + percent-encoded; decode both to match favorite.TrackUri.
        const resRe = /<res[^>]*>([^<]+)<\/res>/;
        let m: RegExpExecArray | null;
        while ((m = itemRe.exec(xml)) !== null) {
            const resMdMatch = resMdRe.exec(m[0]);
            const resMatch = resRe.exec(m[0]);
            if (resMdMatch && resMatch) {
                const trackUri = decodeXmlEntities(resMatch[1])
                    .replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%20/g, ' ');
                this.rawMetadataMap.set(trackUri, resMdMatch[1]);
            }
        }
    }

    // "My Radio Stations" (R:0/0) is a list separate from Sonos Favorites (FV:2). A radio favorite
    // can live there without being in FV:2 — the newer Sonos app splits "Save to Sonos Favorites"
    // from radio-station saves / pinned collections (issue #3). Returns the R:0/0 entries that
    // aren't already represented in `existing` (matched by TrackUri or case-folded title). Best
    // effort: on any failure returns [] so the FV:2 list still stands.
    private async fetchExtraRadioStations(existing: SonosFavorite[]): Promise<SonosFavorite[]> {
        if (!this.deviceForFetching) return [];
        try {
            const resp = await this.deviceForFetching.GetFavoriteRadioStations();
            if (!Array.isArray(resp.Result)) return [];
            const seen = new Set<string>();
            for (const f of existing) {
                if (f.TrackUri) seen.add(f.TrackUri);
                if (f.Title) seen.add(f.Title.trim().toLowerCase());
            }
            return (resp.Result as unknown as SonosFavorite[]).filter((r) => {
                if (SonosFavoritesCache.isUnplayableBrowseCategory(r)) return false;
                const title = (r.Title ?? '').trim().toLowerCase();
                return !(r.TrackUri && seen.has(r.TrackUri)) && !(title && seen.has(title));
            });
        } catch (e) {
            streamDeck.logger.debug(`[FavCache] R:0/0 radio-station fetch failed: ${e}`);
            return [];
        }
    }

    // Sonos's newer app is known to inject browse-category rows into FV:2 that the user never
    // added — "Aktuell angesagt" (sd:IE:trending-now), "Sonos präsentiert" (sd:IE:sonos-presents)
    // and similar (widespread Sonos-side bug, no fix from Sonos — see the favourites threads on
    // their community forum). They are folders, not content: pressing one plays nothing. Detect
    // via the <r:resMD> inner item (fav.UpnpClass is useless here — the lib reports every FV:2
    // entry as the mangled "object.itemobject.item.sonos-favorite"): a bare
    // <upnp:class>object.container</upnp:class> (no subtype) AND an id pointing at a Sonos Radio
    // catalog node (".../stations/..."). Deliberately narrow — a real NAS-folder favourite is
    // object.container too but has a <res> (so TrackUri is set), and TIDAL "Artist Radio" /
    // "Top Tracks" are object.container.playlistContainer (a subtype) and still play via
    // SonosFavoritePlayer's resMD path.
    private static isUnplayableBrowseCategory(fav: SonosFavorite): boolean {
        if (fav.TrackUri || typeof fav.ResMD !== 'string') return false;
        const resMd = fav.ResMD.replace(/%2F/gi, '/').replace(/__UNENCODED_SLASH__/g, '/');
        const cls = resMd.match(/<upnp:class>([^<]+)<\/upnp:class>/)?.[1];
        return cls === 'object.container' && /<item\b[^>]*\bid="[^"]*\/stations\//.test(resMd);
    }

    public getFavorites(): SonosFavorite[] | null {
        return this.favorites;
    }

    public areFavoritesLoaded(): boolean {
        return this.hasFetchedFavorites;
    }

    public getResMd(trackUri: string): string | undefined {
        return this.rawMetadataMap.get(trackUri);
    }

    public getCoverArt(imageUrl: string): string | undefined {
        return this.coverArtCache.get(imageUrl);
    }

/**
 * Processes a list of favorites to download and scale their cover art.
 */
private async processCoverArts(favorites: SonosFavorite[]): Promise<void> {
    streamDeck.logger.debug(`Processing cover art for ${favorites.length} favorites.`);
    
    const coverArtPromises = favorites.map(async (fav) => {
        const url = fav.AlbumArtUri;
        const title = fav.Title || 'Unknown favorite';

        if (!url) {
            streamDeck.logger.debug(`Favorite "${title}" has no cover image — default icon will be shown.`);
            return;
        }

        if (this.coverArtCache.has(url)) {
            streamDeck.logger.debug(`Cover for "${title}" already in cache.`);
            return;
        }

        await this.fetchAndScaleCoverArt(url, title);
    });

    await Promise.all(coverArtPromises);
    streamDeck.logger.debug('Cover art processing complete.');
}

/**
 * Fetches a single cover art image, scales it, and stores it as a base64 string.
 */
private async fetchAndScaleCoverArt(imageUrl: string, title: string): Promise<void> {
    if (!this.deviceForFetching) return;

    try {
        let sanitizedUrl = imageUrl;
        const firstQuestionMark = sanitizedUrl.indexOf('?');
        if (firstQuestionMark !== -1) {
            let searchPart = sanitizedUrl.substring(firstQuestionMark + 1);
            searchPart = searchPart.replace(/\?/g, '&');
            sanitizedUrl = sanitizedUrl.substring(0, firstQuestionMark + 1) + searchPart;
        }

        const url = new URL(sanitizedUrl, `http://${this.deviceForFetching.Host}:1400`);
        
        const response = await fetch(url.toString());
        if (!response.ok) {
            streamDeck.logger.warn(`Cover for "${title}" could not be loaded (HTTP ${response.status}).`);
            return;
        }

        const imageBuffer = await response.arrayBuffer();

        const decoded = decodeImage(Buffer.from(imageBuffer));
        if (!decoded) {
            streamDeck.logger.debug(`Cover for "${title}" could not be decoded.`);
            return;
        }
        const resized = resizeRGBA(decoded, 72, 72);
        const base64Image = encodePngDataUri(72, 72, resized);
        this.coverArtCache.set(imageUrl, base64Image);

    } catch {
        streamDeck.logger.debug(`Cover processing for "${title}" skipped.`);
    }
}
}

// Shared module-level instance — same pattern as sonosDeviceManager/sonosGroupManager
// (the getInstance() singleton boilerplate this replaced added nothing over a plain const).
export const sonosFavoritesCache = new SonosFavoritesCache();
