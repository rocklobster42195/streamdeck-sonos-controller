import { action, type DialAction, type WillAppearEvent } from "@elgato/streamdeck";
import { VolumeDialAction } from "@rocklobster42195/streamdeck-kit/keys";
import { mdiPath } from "@rocklobster42195/streamdeck-kit/mdi";
import { panoramaContextGroupKey, panoramaRows, renderPanoramaEffectSlice, socRowState } from "../effects/panorama";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { buildUnconfiguredDialSvg, buildUnreachableDialSvg } from "../utils/icons";
import { piT } from "../utils/pi-i18n";
import { deviceOf } from "./deck-players";
import { speakerBoard } from "./speaker-board";
import { SpeakerHolds } from "./speaker-holds";
import { migrateVolumeDial, type VolumeDialSettings } from "./volume-dial-migrate";

const svgUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

/**
 * The universal Volume dial (the kit's, as the keys): rotate sets the volume of any player on the
 * deck, push mutes, a tap recalls the preset, a long tap saves it. The look stays Sonos
 * Controller's; the dial takes part in its row's Panorama as before.
 */
@action({ UUID: "de.boriskemper.sonos-controller.volume-dial" })
export class VolumeDial extends VolumeDialAction<VolumeDialSettings> {
    /** The dials in their row's Panorama, with the settings it asks for. */
    private readonly inRows = new Map<string, VolumeDialSettings>();
    /** The speaker each dial holds a connection to (its own volume). */
    private readonly speakers = new SpeakerHolds("volume-dial", (id) => this.redraw(id));

    constructor() {
        super({
            board: speakerBoard,
            // One percent per tick, as the dial always did (a fast spin doubles it)
            defaultStep: 1,
            iconPath: (name) => mdiPath(name),
            rowColor: (deviceId) => panoramaRows.rowColor(deviceId),
            underlay: (id) => {
                const key = panoramaContextGroupKey.get(id);
                return key ? renderPanoramaEffectSlice(key) : undefined;
            },
            mutedLabel: () => piT("Muted (short)"),
            noPlayerLabel: () => piT("Volume"),
            migrate: (s) => migrateVolumeDial(s, deviceOf),
            unavailable: (s) => svgUri(s.player ? buildUnreachableDialSvg(piT("Volume").toUpperCase()) : buildUnconfiguredDialSvg(piT("Volume").toUpperCase())),
            onShown: (a, s) => this.joinRow(a, s),
            onSettings: (a, s) => {
                this.inRows.set(a.id, s);
                panoramaRows.changed(a.id);
                this.speakers.hold(a.id, s.player);
            },
            onHidden: (id) => {
                this.inRows.delete(id);
                panoramaRows.remove(id);
                this.speakers.hold(id, undefined);
            },
        });
    }

    /** Old dials name their speaker by address: wait for discovery, so it becomes the speaker's id. */
    override async onWillAppear(ev: WillAppearEvent<VolumeDialSettings>): Promise<void> {
        await discoveryPromise;
        super.onWillAppear(ev);
    }

    /** Joins the dial's row in the Panorama (the row decides whether it shows the effect), or tells it the settings changed. */
    private joinRow(a: DialAction<VolumeDialSettings>, settings: VolumeDialSettings): void {
        const id = a.id;
        this.speakers.hold(id, settings.player);
        if (this.inRows.has(id)) {
            this.inRows.set(id, settings);
            panoramaRows.changed(id);
            return;
        }
        this.inRows.set(id, settings);
        panoramaRows.add(id, {
            device: a.device.id,
            column: a.coordinates?.column ?? 0,
            label: () => speakerBoard.resolve(this.inRows.get(id)?.player)?.name ?? piT("Volume"),
            state: () => {
                const s = this.inRows.get(id) ?? {};
                const mode = s.visualizerMode as string | undefined;
                return socRowState(s, mode && mode !== "none" ? mode : undefined);
            },
            save: (patch) => {
                const current = this.inRows.get(id);
                if (!current) return;
                const next = { ...current, ...patch } as VolumeDialSettings;
                this.inRows.set(id, next);
                void a.setSettings(next);
            },
            redraw: () => this.redraw(id),
        });
    }
}
