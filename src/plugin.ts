import streamDeck from "@elgato/streamdeck";
import "./sonos/sonos-discovery"; // This will start the discovery process

import { SonosTogglePlay } from "./actions/sonos-toggle-play";
import { SonosDialVolume } from "./actions/sonos-dial-volume";
import { SonosPlaybackControl } from "./actions/sonos-playback-control";
import { SonosPlayFavorite } from "./actions/sonos-play-favorite";
import { SonosKeyVolume } from "./actions/sonos-key-volume";
import { SonosDialTrack } from "./actions/sonos-dial-track";
import { SonosDialFavorites } from "./actions/sonos-dial-favorites";
import { SonosDialParticles } from "./actions/sonos-dial-particles";
import { SonosDialGroupVolume } from "./actions/sonos-dial-group-volume";
import { SonosDialDiagnostics } from "./actions/sonos-dial-diagnostics";
import { SonosDialQueue } from "./actions/sonos-dial-queue";
import { registerGracefulShutdown } from "./utils/graceful-shutdown";

streamDeck.logger.setLevel("info");

// Register the actions that this plugin supports.
streamDeck.actions.registerAction(new SonosTogglePlay());
streamDeck.actions.registerAction(new SonosDialVolume());
streamDeck.actions.registerAction(new SonosPlaybackControl());
streamDeck.actions.registerAction(new SonosPlayFavorite());
streamDeck.actions.registerAction(new SonosKeyVolume());
streamDeck.actions.registerAction(new SonosDialTrack());
streamDeck.actions.registerAction(new SonosDialFavorites());
streamDeck.actions.registerAction(new SonosDialParticles());
streamDeck.actions.registerAction(new SonosDialGroupVolume());
streamDeck.actions.registerAction(new SonosDialDiagnostics());
streamDeck.actions.registerAction(new SonosDialQueue());

// Finally, connect to the Stream Deck immediately.
streamDeck.connect();
streamDeck.logger.info('Stream Deck plugin connected. Discovery running in background.');

// UNSUBSCRIBE all UPnP subscriptions in the grace window when Stream Deck stops/restarts the
// plugin (websocket close) or the process is signalled — see graceful-shutdown.ts for why.
registerGracefulShutdown();