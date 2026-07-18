import streamDeck from "@elgato/streamdeck";
import "./sonos/sonos-discovery"; // This will start the discovery process
// Diagnostic-heartbeat imports — see the disabled block at the bottom of this file.
// import { sonosDeviceManager } from "./sonos/SonosDeviceManager";
// import { marqueeAnimator } from "./utils/MarqueeAnimator";
// import { titleAnimator } from "./utils/TitleAnimator";
// import { panoramaDebugSummary } from "./effects/PanoramaOrchestrator";

import { PlayPauseKey } from "./actions/play-pause-key";
import { VolumeDial } from "./actions/volume-dial";
import { PlaybackControlKey } from "./actions/playback-control-key";
import { PlayFavoriteKey } from "./actions/play-favorite-key";
import { VolumeControlKey } from "./actions/volume-control-key";
import { TrackControlDial } from "./actions/track-control-dial";
import { FavoritesDial } from "./actions/favorites-dial";
import { PanoramaEffectsDial } from "./actions/panorama-effects-dial";
import { GroupVolumeDial } from "./actions/group-volume-dial";
import { DiagnosticsDial } from "./actions/diagnostics-dial";
import { QueueDial } from "./actions/queue-dial";
import { MultiControlKey } from "./actions/multi-control-key";
import { registerGracefulShutdown } from "./utils/graceful-shutdown";

streamDeck.logger.setLevel("info");

// Register the actions that this plugin supports.
streamDeck.actions.registerAction(new PlayPauseKey());
streamDeck.actions.registerAction(new VolumeDial());
streamDeck.actions.registerAction(new PlaybackControlKey());
streamDeck.actions.registerAction(new PlayFavoriteKey());
streamDeck.actions.registerAction(new VolumeControlKey());
streamDeck.actions.registerAction(new TrackControlDial());
streamDeck.actions.registerAction(new FavoritesDial());
streamDeck.actions.registerAction(new PanoramaEffectsDial());
streamDeck.actions.registerAction(new GroupVolumeDial());
streamDeck.actions.registerAction(new DiagnosticsDial());
streamDeck.actions.registerAction(new QueueDial());
streamDeck.actions.registerAction(new MultiControlKey());

// Finally, connect to the Stream Deck immediately.
streamDeck.connect();
streamDeck.logger.info('Stream Deck plugin connected. Discovery running in background.');

// UNSUBSCRIBE all UPnP subscriptions in the grace window when Stream Deck stops/restarts the
// plugin (websocket close) or the process is signalled — see graceful-shutdown.ts for why.
registerGracefulShutdown();

// Temporary diagnostic (2026-07-18), disabled 2026-07-18 — root cause found (the FavDial-lag
// report was a 14-listener synchronous render burst on playlist/favorite change, not an uptime
// leak; see project-favdial-lag-2026-07-18 memory), so this heartbeat's noisy every-5-min log line
// was switched off. Uncomment (together with the imports above) to re-enable: periodic snapshot of
// every shared registration map's size, to catch a suspected leak (stale contexts never
// unregistered on a real hardware Stream Deck) that would make render fan-out gradually more
// expensive the longer the plugin runs. Compare the first heartbeat (fresh restart) against later
// ones (after hours of uptime) for unexplained growth.
// const HEARTBEAT_MS = 5 * 60 * 1000;
// setInterval(() => {
//     streamDeck.logger.info(
//         `[Diag heartbeat] devices: ${sonosDeviceManager.debugSummary()} | ` +
//         `marquee=${marqueeAnimator.activeCount} title=${titleAnimator.activeCount} | ` +
//         `panorama: ${panoramaDebugSummary()}`
//     );
// }, HEARTBEAT_MS);
