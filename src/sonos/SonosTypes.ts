import { Track } from "@svrooij/sonos/lib/models";

export type TrackInfo = Track & {
    albumArtDataUri?: string;
    isRadio?: boolean;
};

export type VolumeInfo = {
    volume: number;
    mute: boolean;
};

