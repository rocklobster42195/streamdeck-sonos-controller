import { action, type WillAppearEvent } from "@elgato/streamdeck";
import { PlayPauseKeyAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaRows } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { deckPlayers, deviceOf } from "./deck-players";
import { migratePlayPause, type PlayPauseSettings } from "./play-pause-migrate";

/** The universal Play/Pause key (the kit's, as in MA-C and System Audio Controller), on every player of the deck. */
@action({ UUID: "de.boriskemper.sonos-controller.play-pause-key" })
export class PlayPauseKey extends PlayPauseKeyAction<PlayPauseSettings> {
    constructor() {
        super({
            board: deckPlayers,
            markerPath: (name) => mdiPath(name),
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            migrate: (s) => migratePlayPause(s, deviceOf),
        });
    }

    /** Old keys name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<PlayPauseSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
    }
}
