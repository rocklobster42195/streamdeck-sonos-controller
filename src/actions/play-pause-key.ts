import { action, type WillAppearEvent } from "@elgato/streamdeck";
import { PlayPauseKeyAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { socPlayers } from "../bus/soc-players";
import { panoramaRows } from "../effects/panorama";
import { discoveryPromise, safeDevices } from "../sonos/sonos-discovery";
import { migratePlayPause, SONOS_IP_PREFIX, type PlayPauseSettings } from "./play-pause-migrate";

/** A speaker's id by its address, once discovery knows it. */
function deviceOf(ip: string): string | undefined {
    return safeDevices().find((d) => d.Host === ip)?.Uuid || undefined;
}

/**
 * The deck's players as the key sees them: a key moved over while its speaker was offline is bound
 * by address ("sonos-ip:…") and finds the speaker once it's back.
 */
const players: Pick<typeof socPlayers, "resolve" | "send" | "onChange"> = {
    resolve: (choice) => {
        if (!choice?.startsWith(SONOS_IP_PREFIX)) return socPlayers.resolve(choice);
        const device = deviceOf(choice.slice(SONOS_IP_PREFIX.length));
        return device ? socPlayers.resolve(`device:${device}`) : undefined;
    },
    send: (target, command, value) => socPlayers.send(target, command, value),
    onChange: (fn) => socPlayers.onChange(fn),
};

/** The universal Play/Pause key (the kit's, as in MA-C and System Audio Controller), on every player of the deck. */
@action({ UUID: "de.boriskemper.sonos-controller.play-pause-key" })
export class PlayPauseKey extends PlayPauseKeyAction<PlayPauseSettings> {
    constructor() {
        super({
            board: players,
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
