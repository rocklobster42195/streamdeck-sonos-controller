import streamDeck from "@elgato/streamdeck";
import "./sonos/sonos-discovery"; // This will start the discovery process

import { SonosTogglePlay } from "./actions/sonos-toggle-play";
import { SonosDialVolume } from "./actions/sonos-dial-volume";
import { SonosPlaybackControlAction } from "./actions/sonos-playback-control";
import { SonosPlayFavoriteAction } from "./actions/sonos-play-favorite";
import { SonosKeyVolumeAction } from "./actions/sonos-key-volume";
import { SonosDialTrack } from "./actions/sonos-dial-track";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("debug"); // "trace" | "debug" | "info" | "warn" | "error" | "silent"

// Register the actions that this plugin supports.
streamDeck.actions.registerAction(new SonosTogglePlay());
streamDeck.actions.registerAction(new SonosDialVolume());
streamDeck.actions.registerAction(new SonosPlaybackControlAction());
streamDeck.actions.registerAction(new SonosPlayFavoriteAction());
streamDeck.actions.registerAction(new SonosKeyVolumeAction());
streamDeck.actions.registerAction(new SonosDialTrack());

// Finally, connect to the Stream Deck immediately.
streamDeck.connect();
streamDeck.logger.info('Stream Deck plugin connected. Discovery running in background.');