import { action, type DidReceiveSettingsEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { VolumeKeyAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaRows } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { deviceOf } from "./deck-players";
import { migrateVolume, type VolumeSettings } from "./play-pause-migrate";
import { speakerBoard } from "./speaker-board";
import { SpeakerHolds } from "./speaker-holds";

/**
 * The universal Volume key (the kit's, as in MA-C): louder, quieter, mute, a preset, for any player
 * on the deck. Bound to one of SO-C's speakers it sets that speaker's own volume, also while it
 * plays in a group (as the key always did; the group's is the Group Volume dial's).
 */
@action({ UUID: "de.boriskemper.sonos-controller.volume-control-key" })
export class VolumeControlKey extends VolumeKeyAction<VolumeSettings> {
    private readonly speakers = new SpeakerHolds("volume-key", (id) => this.redraw(id));

    constructor() {
        super({
            board: speakerBoard,
            markerPath: (name) => mdiPath(name),
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            migrate: (s) => migrateVolume(s, deviceOf),
        });
    }

    /** Old keys name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<VolumeSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
        this.speakers.hold(ev.action.id, (migrateVolume(ev.payload.settings, deviceOf) ?? ev.payload.settings).player);
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<VolumeSettings>): void {
        super.onDidReceiveSettings(ev);
        this.speakers.hold(ev.action.id, ev.payload.settings.player);
    }

    override onWillDisappear(ev: WillDisappearEvent<VolumeSettings>): void {
        super.onWillDisappear(ev);
        this.speakers.hold(ev.action.id, undefined);
    }
}
