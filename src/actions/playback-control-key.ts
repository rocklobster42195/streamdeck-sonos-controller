import { action, type WillAppearEvent } from "@elgato/streamdeck";
import { PlaybackControlKeyAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaRows } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { deckPlayers, deviceOf } from "./deck-players";
import { migratePlayback, type PlaybackSettings } from "./play-pause-migrate";

/**
 * The universal Playback Control key (the kit's, as in MA-C): next, previous, shuffle, repeat for
 * any player on the deck; crossfade and "Don't stop the music" where Music Assistant plays.
 */
@action({ UUID: "de.boriskemper.sonos-controller.playback-control-key" })
export class PlaybackControlKey extends PlaybackControlKeyAction<PlaybackSettings> {
    constructor() {
        super({
            board: deckPlayers,
            markerPath: (name) => mdiPath(name),
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            migrate: (s) => migratePlayback(s, deviceOf),
        });
    }

    /** Old keys name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<PlaybackSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
    }
}
