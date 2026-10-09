import { action, type WillAppearEvent } from "@elgato/streamdeck";
import { VolumeKeyAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaRows } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { deckPlayers, deviceOf } from "./deck-players";
import { migrateVolume, type VolumeSettings } from "./play-pause-migrate";

/** The universal Volume key (the kit's, as in MA-C): louder, quieter, mute, a preset, for any player on the deck. */
@action({ UUID: "de.boriskemper.sonos-controller.volume-control-key" })
export class VolumeControlKey extends VolumeKeyAction<VolumeSettings> {
    constructor() {
        super({
            board: deckPlayers,
            markerPath: (name) => mdiPath(name),
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            migrate: (s) => migrateVolume(s, deviceOf),
        });
    }

    /** Old keys name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<VolumeSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
    }
}
