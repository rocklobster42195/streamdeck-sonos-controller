import { Track } from "@svrooij/sonos/lib/models";

export type TrackInfo = Track & {
    albumArtDataUri?: string;
    isRadio?: boolean;
};

/**
 * A Sonos favorite as cached by SonosFavoritesCache (ContentDirectory Browse of FV:2, parsed by
 * the lib's GetFavorites). Replaces the `favorite: any` that used to flow through
 * SonosFavoritePlayer, FavoritesDial and PlayFavoriteKey. The index signature tolerates extra
 * lib fields (Album, Duration, ...) that no plugin code reads by name.
 */
export interface SonosFavorite {
    Title: string;
    TrackUri: string;
    ItemId?: string;
    ParentId?: string;
    AlbumArtUri?: string;
    ProtocolInfo?: string;
    UpnpClass?: string;
    /** Synthetic Favorites-Dial entry for the Line-In input — not a real Sonos favorite. */
    isLineIn?: boolean;
    [key: string]: unknown;
}

export type VolumeInfo = {
    volume: number;
    mute: boolean;
};

