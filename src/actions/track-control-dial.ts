import { action, type DialAction, type WillAppearEvent } from "@elgato/streamdeck";
import { TrackDialAction } from "@rocklobster42195/streamdeck-kit/keys";
import { panoramaContextGroupKey, panoramaRows, renderPanoramaEffectSlice, socRowState } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { renderBatteryBadge } from "../utils/icons";
import { piT } from "../utils/pi-i18n";
import { deckPlayers, deviceOf } from "./deck-players";
import { migrateTrackDial, type TrackDialSettings } from "./track-dial-migrate";

/**
 * The universal Track dial (the kit's, as the keys): cover, title, artist and progress of any
 * player on the deck; rotate seeks, push skips, a tap plays or pauses. The look stays Sonos
 * Controller's: the cover on the right, the Equalizer, the battery of a Roam or Move, and the dial
 * takes part in its row's Panorama as before.
 */
@action({ UUID: "de.boriskemper.sonos-controller.track-control-dial" })
export class TrackControlDial extends TrackDialAction<TrackDialSettings> {
    /** The dials in their row's Panorama, with the settings it asks for. */
    private readonly inRows = new Map<string, TrackDialSettings>();

    constructor() {
        super({
            board: deckPlayers,
            // The manifest's "$A0" layout has a title, icon and indicator of its own ("Track Control"): cleared
            feedback: { title: "", icon: "", indicator: { value: 0, enabled: false } },
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            underlay: (id) => {
                const key = panoramaContextGroupKey.get(id);
                return key ? renderPanoramaEffectSlice(key) : undefined;
            },
            // The battery of a speaker that has one, in the cover's corner (as before)
            badge: (id, p) => {
                const s = this.inRows.get(id);
                if (p.battery === undefined) return undefined;
                const x = s?.coverSide === "left" ? 82 : 182;
                return renderBatteryBadge(s?.batteryDisplayMode ?? "warning", { percent: p.battery, charging: !!p.charging }, x, 10, 18) || undefined;
            },
            nothingLabel: () => piT("Track"),
            // As the dial always was: the Equalizer, until the user picks track info
            defaultLook: "eq",
            migrate: (s) => migrateTrackDial(s, deviceOf),
            onShown: (a, s) => this.joinRow(a, s),
            onSettings: (a, s) => {
                this.inRows.set(a.id, s);
                panoramaRows.changed(a.id);
            },
            onHidden: (id) => {
                this.inRows.delete(id);
                panoramaRows.remove(id);
            },
        });
    }

    /** Old dials name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<TrackDialSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
    }

    /** Joins the dial's row in the Panorama (the row decides whether it shows the effect), or tells it the settings changed. */
    private joinRow(a: DialAction<TrackDialSettings>, settings: TrackDialSettings): void {
        const id = a.id;
        if (this.inRows.has(id)) {
            this.inRows.set(id, settings);
            panoramaRows.changed(id);
            return;
        }
        this.inRows.set(id, settings);
        panoramaRows.add(id, {
            device: a.device.id,
            column: a.coordinates?.column ?? 0,
            label: () => piT("Track"),
            state: () => {
                const s = this.inRows.get(id) ?? {};
                const mode = s.visualizerMode;
                // The Equalizer is the dial's own look, not an effect of the row
                return socRowState(s, mode && mode !== "none" && mode !== "eq" ? mode : undefined);
            },
            save: (patch) => {
                const current = this.inRows.get(id);
                if (!current) return;
                const next = { ...current, ...patch } as TrackDialSettings;
                this.inRows.set(id, next);
                void a.setSettings(next);
            },
            redraw: () => this.redraw(id),
        });
    }
}
