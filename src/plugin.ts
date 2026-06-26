import streamDeck from "@elgato/streamdeck";
import "./sonos/sonos-discovery"; // This will start the discovery process

import { SonosTogglePlay } from "./actions/sonos-toggle-play";
import { SonosDialVolume } from "./actions/sonos-dial-volume";
import { SonosPlaybackControl } from "./actions/sonos-playback-control";
import { SonosPlayFavorite } from "./actions/sonos-play-favorite";
import { SonosKeyVolume } from "./actions/sonos-key-volume";
import { SonosDialTrack } from "./actions/sonos-dial-track";

streamDeck.logger.setLevel("info");

// Register the actions that this plugin supports.
streamDeck.actions.registerAction(new SonosTogglePlay());
streamDeck.actions.registerAction(new SonosDialVolume());
streamDeck.actions.registerAction(new SonosPlaybackControl());
streamDeck.actions.registerAction(new SonosPlayFavorite());
streamDeck.actions.registerAction(new SonosKeyVolume());
streamDeck.actions.registerAction(new SonosDialTrack());

// Finally, connect to the Stream Deck immediately.
streamDeck.connect();
streamDeck.logger.info('Stream Deck plugin connected. Discovery running in background.');