
import { SonosDevice, ServiceEvents } from '@svrooij/sonos';
import sharp from 'sharp';
import streamDeck from '@elgato/streamdeck';

/**
 * A cache for Sonos favorites and their scaled cover art.
 * This class is designed as a singleton to be shared across the plugin.
 */
class SonosFavoritesCache {
    private static instance: SonosFavoritesCache;

    // Cache for the system-wide list of favorites.
    private favorites: any[] | null = null;
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

    // Private constructor to enforce singleton pattern.
    private constructor() {}

    /**
     * Gets the singleton instance of the cache.
     */
    public static getInstance(): SonosFavoritesCache {
        if (!SonosFavoritesCache.instance) {
            SonosFavoritesCache.instance = new SonosFavoritesCache();
        }
        return SonosFavoritesCache.instance;
    }

    /**
     * Starts the automatic refresh mechanism.
     * @param device A Sonos device to be used for future polling.
     */
    public async start(device: SonosDevice): Promise<void> {
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

            // Raw Browse call to extract r:resMD metadata per favorite before the SDK discards it.
            // GetFavorites() uses BrowseParsedWithDefaults which loses the r:resMD field.
            const rawResponse = await this.deviceForFetching.ContentDirectoryService.Browse({
                ObjectID: 'FV:2',
                BrowseFlag: 'BrowseDirectChildren',
                Filter: '*',
                StartingIndex: 0,
                RequestedCount: 0,
                SortCriteria: '',
            });
            if (typeof rawResponse.Result === 'string') {
                this.rawMetadataMap.clear();
                // rawResponse.Result is plain XML (outer SOAP entities decoded). The <r:resMD>
                // child element contains the already-HTML-encoded DIDL-Lite that SetAVTransportURI
                // expects — it is stored verbatim and passed as a string to bypass TrackToMetaData.
                const xml = rawResponse.Result;
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
                        // HTML-decode and URL-decode the raw URI to get the canonical TrackUri.
                        const trackUri = resMatch[1]
                            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
                            .replace(/%3A/gi, ':').replace(/%2F/gi, '/').replace(/%20/g, ' ');
                        this.rawMetadataMap.set(trackUri, resMdMatch[1]);
                    }
                }
                streamDeck.logger.info(`[FavCache] Stored r:resMD metadata for ${this.rawMetadataMap.size} favorites.`);
            }

            const favoritesResponse = await this.deviceForFetching.GetFavorites();
            if (Array.isArray(favoritesResponse.Result)) {
                this.favorites = favoritesResponse.Result;
                this.hasFetchedFavorites = true;
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

    public getFavorites(): any[] | null {
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
private async processCoverArts(favorites: any[]): Promise<void> {
    streamDeck.logger.info(`Processing cover art for ${favorites.length} favorites.`);
    
    const coverArtPromises = favorites.map(async (fav) => {
        const url = fav.AlbumArtUri;
        const title = fav.Title || 'Unknown favorite';

        if (!url) {
            streamDeck.logger.info(`Favorite "${title}" has no cover image — default icon will be shown.`);
            return;
        }

        if (this.coverArtCache.has(url)) {
            streamDeck.logger.debug(`Cover for "${title}" already in cache.`);
            return;
        }

        await this.fetchAndScaleCoverArt(url, title);
    });

    await Promise.all(coverArtPromises);
    streamDeck.logger.info('Cover art processing complete.');
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
            streamDeck.logger.info(`Cover for "${title}" could not be loaded (HTTP ${response.status}).`);
            return;
        }

        const imageBuffer = await response.arrayBuffer();

        const scaledImageBuffer = await sharp(Buffer.from(imageBuffer))
            .resize(72, 72)
            .png()
            .toBuffer();

        const base64Image = `data:image/png;base64,${scaledImageBuffer.toString('base64')}`;
        this.coverArtCache.set(imageUrl, base64Image);

    } catch (error) {
        streamDeck.logger.info(`Cover processing for "${title}" skipped.`);
    }
}
}

// Export the singleton instance.
export const sonosFavoritesCache = SonosFavoritesCache.getInstance();
