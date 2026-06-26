import { Track } from "@svrooij/sonos/lib/models";

export type TrackInfo = Track & {
    albumArtDataUri?: string;
    isRadio?: boolean;
};

export type VolumeInfo = {
    volume: number;
    mute: boolean;
};

export interface SonosStatus {
  isPlaying?: boolean;
  volume: number;
  currentTitle: string;
  currentArtist: string;
  AlbumArtUri: string;
}

export interface SonosZoneGroupState {
  groupId: string;
  name: string;
  coordinator: {
    name: string;
    uuid: string;
    host: string;
    port: number;
    ChannelMapSet?: Record<string, string>;
    Icon?: string;
    MicEnabled: boolean;
    Invisible: boolean;
    SoftwareVersion: string;
    SwGen: string;
    HasConfiguredSSID: boolean;
    WifiEnabled: boolean;
    TVConfigurationError: number;
    HdmiCecAvailable: boolean;
  };
  members: {
    name: string;
    uuid: string;
    host: string;
    port: number;
    ChannelMapSet?: Record<string, string>;
    Icon?: string | number; // "Icon" can be a string or 0 based on the JSON
    MicEnabled: boolean;
    Invisible: boolean;
    SoftwareVersion: string;
    SwGen: string;
    HasConfiguredSSID: boolean;
    WifiEnabled: boolean;
    TVConfigurationError: number;
    HdmiCecAvailable: boolean;
  }[];
}

export type SonosZoneGroupStates = SonosZoneGroupState[];