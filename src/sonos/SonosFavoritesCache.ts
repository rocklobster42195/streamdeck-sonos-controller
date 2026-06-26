
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
        const title = fav.Title || 'Unbekannter Favorit';

        if (!url) {
            // Nur eine Info-Log, kein Error. Stream Deck zeigt dann das Standard-Icon.
            streamDeck.logger.info(`Favorit "${title}" hat kein Cover-Bild. Standard-Icon wird verwendet.`);
            return;
        }

        if (this.coverArtCache.has(url)) {
            streamDeck.logger.debug(`Cover für "${title}" bereits im Cache.`);
            return;
        }

        // Starte den Download/Resize Prozess
        await this.fetchAndScaleCoverArt(url, title);
    });

    await Promise.all(coverArtPromises);
    streamDeck.logger.info(`Verarbeitung der Cover-Bilder abgeschlossen.`);
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
            // Info statt Error, falls z.B. die Datei auf dem NAS nicht gefunden wurde (404)
            streamDeck.logger.info(`Cover für "${title}" konnte nicht geladen werden (HTTP ${response.status}).`);
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
        // Auch hier: Info statt Error-Log, um das Log-File sauber zu halten
        streamDeck.logger.info(`Cover-Verarbeitung für "${title}" übersprungen.`);
    }
}
}

// Export the singleton instance.
export const sonosFavoritesCache = SonosFavoritesCache.getInstance();
