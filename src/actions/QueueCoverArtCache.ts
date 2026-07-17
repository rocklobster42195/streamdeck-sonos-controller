// Small, per-context cover art cache for Queue Dial's carousel. Deliberately NOT a shared
// singleton like SonosFavoritesCache — each dial instance browses its own device's queue, so
// there's no cross-instance reuse to gain, and keeping it scoped avoids unbounded growth across
// unrelated dials. loadImageFromUri (src/sonos/cover-art-loader.ts) itself has no memoization, so callers
// that re-visit the same queue item while scrolling back and forth need this.
export class QueueCoverArtCache {
    private static readonly MAX_ENTRIES = 300;
    private cache: Map<string, string> = new Map();

    get(key: string): string | undefined {
        return this.cache.get(key);
    }

    has(key: string): boolean {
        return this.cache.has(key);
    }

    set(key: string, dataUri: string): void {
        if (this.cache.size >= QueueCoverArtCache.MAX_ENTRIES && !this.cache.has(key)) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(key, dataUri);
    }

    clear(): void {
        this.cache.clear();
    }
}
