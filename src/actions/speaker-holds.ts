// The connection a Volume dial or key holds to its own speaker (see speaker-board.ts): for as long
// as it shows a choice that is one of SO-C's speakers, so its own volume and mute are known.
import type { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { dropSpeaker, holdSpeaker, speakerIpOf } from "./speaker-board";

type Entry = { choice: string; ip: string; controller?: SonosDeviceController };

export class SpeakerHolds {
    private readonly entries = new Map<string, Entry>();

    /** `tag` names this holder's volume callback; `changed` redraws a dial or key whose speaker's volume moved. */
    constructor(
        private readonly tag: string,
        private readonly changed: (id: string) => void,
    ) {}

    /** The dial or key `id` shows `choice` now (undefined: nothing, or it went away). */
    hold(id: string, choice: string | undefined): void {
        const current = this.entries.get(id);
        if (current && current.choice === choice) return;
        if (current) {
            this.entries.delete(id);
            if (current.controller) {
                current.controller.unregisterVolumeCallback(`${this.tag}-${id}`);
                dropSpeaker(current.choice, current.controller);
                sonosDeviceManager.releaseController(current.ip);
            }
        }
        const ip = speakerIpOf(choice);
        if (!choice || !ip) return;
        const entry: Entry = { choice, ip };
        this.entries.set(id, entry);
        void sonosDeviceManager
            .getController(ip)
            .then((controller) => {
                // Gone or changed meanwhile: give the connection back
                if (this.entries.get(id) !== entry) {
                    sonosDeviceManager.releaseController(ip);
                    return;
                }
                entry.controller = controller;
                holdSpeaker(choice, controller);
                controller.registerVolumeCallback(`${this.tag}-${id}`, () => this.changed(id));
                this.changed(id);
            })
            .catch(() => {
                // The speaker is off: shown as not found until it is back
            });
    }
}
