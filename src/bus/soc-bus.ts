// SO-C on deckbus (the kit's docs/deckbus-protocol.md): shares the Panorama with other plugins'
// dials in the same row (one effect per row, agreed between the plugins), tells them where its
// actions are, and whether it found Sonos speakers. Local only; SO-C works on without the bus.
import { socCovers } from "./soc-covers";
import streamDeck from "@elgato/streamdeck";
import { DeckBus } from "@rocklobster42195/streamdeck-kit/bus";
import { panorama, panoramaRows, shareActionsTo, socActions } from "../effects/panorama";
import { onDevicesChanged, safeDevices } from "../sonos/sonos-discovery";

let bus: DeckBus | undefined;
let lastStatus = "";

/** Call after streamDeck.connect() (the plugin version comes from there). */
export async function startSocBus(): Promise<void> {
    bus = new DeckBus({ id: "de.boriskemper.sonos-controller", name: "SO-C", version: streamDeck.info.plugin.version, caps: [] });
    const b = bus;
    shareActionsTo((key, value) => b.setState(key, value));
    b.setState("actions", socActions.list());
    // One Panorama with other plugins' dials next to SO-C's (stays local while nobody is there)
    panorama.connect(b);
    panoramaRows.connect(b);
    // The speakers' cover colours for every plugin's Panorama rows (and later keys)
    socCovers.connect(b);
    if (!(await b.start())) return;
    streamDeck.logger.info(`[deckbus] SO-C in slot ${b.slot}`);
    onDevicesChanged(shareStatus);
    shareStatus();
}

function shareStatus(): void {
    const n = safeDevices().length;
    const status = { online: n > 0, detail: n ? `${n} Sonos speakers` : "no speakers found" };
    const json = JSON.stringify(status);
    if (!bus || json === lastStatus) return;
    lastStatus = json;
    bus.setState("status", status);
}
