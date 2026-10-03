// SO-C's speakers on deckbus (state "covers", the kit's covers.ts): the colour of what each group
// plays, so a Panorama row (and later keys) of any plugin can follow the cover, also without an
// SO-C dial in it. Fed by the speaker connections SO-C has open anyway (for its visible actions):
// no extra connections to the speakers. One entry per group (its coordinator).
import { CoverBoard, readableCoverColor, type CoverEntry } from "@rocklobster42195/streamdeck-kit";
import type { SonosDeviceController } from "../sonos/SonosDeviceController";
import { getDominantColor } from "../utils/color-extract";

export const socCovers = new CoverBoard("SO-C");

const CALLBACK = "soc-covers";

type Group = { name: string; color?: string; coverFor?: string; playing: boolean; since: number };

/** Groups by coordinator UUID, and which group each watched speaker (by IP) belongs to. */
const groups = new Map<string, Group>();
const watched = new Map<string, string>();

/** A speaker connection came up: follow its group's track and play state. */
export function watchCovers(controller: SonosDeviceController): void {
    const ip = controller.deviceIp;
    const key = () => {
        const coordinator = controller.transportDevice;
        const id = coordinator.Uuid || coordinator.Host;
        watched.set(ip, id);
        let g = groups.get(id);
        if (!g) groups.set(id, (g = { name: coordinator.Name || ip, playing: false, since: 0 }));
        return g;
    };
    controller.registerTransportStateCallback(CALLBACK, (ts) => {
        const g = key();
        const playing = ts === "PLAYING";
        if (playing && !g.playing) g.since = Date.now();
        g.playing = playing;
        publish();
    });
    controller.registerTrackInfoCallback(CALLBACK, (ti) => {
        const g = key();
        const cover = ti.albumArtDataUri;
        if (!cover || cover === g.coverFor) return;
        g.coverFor = cover;
        getDominantColor(cover)
            .then((hex) => {
                if (g.coverFor !== cover) return;
                g.color = readableCoverColor(hexToRgb(hex));
                publish();
            })
            .catch(() => {});
    });
    const ts = controller.transportState;
    if (ts) {
        const g = key();
        g.playing = ts === "PLAYING";
        if (g.playing) g.since = Date.now();
    }
}

/** The speaker connection goes: forget its group when no other watched speaker is in it. */
export function unwatchCovers(controller: SonosDeviceController): void {
    controller.unregisterTransportStateCallback(CALLBACK);
    controller.unregisterTrackInfoCallback(CALLBACK);
    const id = watched.get(controller.deviceIp);
    watched.delete(controller.deviceIp);
    if (id && ![...watched.values()].includes(id)) groups.delete(id);
    publish();
}

function publish(): void {
    const entries: CoverEntry[] = [];
    for (const [player, g] of groups) if (g.color) entries.push({ player, name: g.name, color: g.color, playing: g.playing, since: g.since });
    socCovers.publish(entries);
}

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace("#", "").slice(0, 6), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
