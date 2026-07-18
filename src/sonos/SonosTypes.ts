import { Track } from "@svrooij/sonos/lib/models";

export type TrackInfo = Track & {
    albumArtDataUri?: string;
    isRadio?: boolean;
    // True while albumArtDataUri is still the carried-over PREVIOUS track's cover, shown as a
    // placeholder until the real one resolves (see SonosDeviceController's currentTrack handler).
    // Consumers that cache covers by AlbumArtUri must check this instead of inferring "is this
    // fallback data" by comparing to whatever the previous fire looked like — that comparison
    // breaks the moment the SAME still-unresolved track fires MORE than twice in a row (e.g. the
    // "undefined title" transitional event Sonos can emit mid-switch), where the AlbumArtUri
    // matches the immediately-previous fire even though neither fire has a real cover yet, and a
    // completely unrelated track's cover ends up wrongly cached against the new AlbumArtUri.
    // Confirmed on hardware, 2026-07-18 (Queue Dial cached a "90s90s NRW" radio station's cover as
    // an ABBA album cover this way). Undefined/false means the cover is confirmed real.
    coverPending?: boolean;
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

