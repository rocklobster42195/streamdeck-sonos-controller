// SO-C on deckbus (the kit's docs/deckbus-protocol.md): shares the Panorama with other plugins'
// dials in the same row (one effect per row, agreed between the plugins), tells them where its
// actions are, and whether it found Sonos speakers. Pauses or lowers chosen speakers during a call
// on the computer (state "call" from SA-C; the kit's CallReaction). Local only; SO-C works on without the bus.
import { setBatteryProbe, setGroupMembers, socCovers, socPlayers } from "./soc-players";
import { deviceHasBattery } from "../sonos/SonosBattery";
import streamDeck from "@elgato/streamdeck";
import { CALL_SETTING, CallReaction } from "@rocklobster42195/streamdeck-kit";
import { piBridge } from "@rocklobster42195/streamdeck-kit/bridge";
import { DeckBus } from "@rocklobster42195/streamdeck-kit/bus";
import { panorama, panoramaRows, shareActionsTo, socActions } from "../effects/panorama";
import { isInvisibleSatellite, onDevicesChanged, safeDevices } from "../sonos/sonos-discovery";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";

// Before any speaker connection is watched: which speakers report a battery (Roam, Move)
setBatteryProbe(deviceHasBattery);

let bus: DeckBus | undefined;
let lastStatus = "";

// Global setting "othersMayControlPlayers" (default on): other plugins' keys may control SO-C's
// speakers over deckbus ("transport"). Off: they get "not allowed".
let othersMay = true;
const othersMayControlPlayers = () => othersMay;
const readOthersMay = (s: Record<string, unknown>) => (othersMay = s.othersMayControlPlayers !== false);

// "When a call starts on this computer": per speaker nothing / pause / lower (global setting callReaction)
const socCalls = new CallReaction(socPlayers, streamDeck.logger, () => piBridge.schedulePush());
const readGlobal = (s: Record<string, unknown>) => {
    readOthersMay(s);
    socCalls.setChoices(s[CALL_SETTING]);
};

/** Call after streamDeck.connect() (the plugin version comes from there). */
export async function startSocBus(): Promise<void> {
    bus = new DeckBus({ id: "de.boriskemper.sonos-controller", name: "SO-C", version: streamDeck.info.plugin.version, caps: [] });
    const b = bus;
    shareActionsTo((key, value) => b.setState(key, value));
    b.setState("actions", socActions.list());
    // One Panorama with other plugins' dials next to SO-C's (stays local while nobody is there)
    panorama.connect(b);
    panoramaRows.connect(b);
    // The speakers for every plugin: cover colours for Panorama rows, players for keys
    socCovers.connect(b);
    socPlayers.connect(b, { allow: () => othersMayControlPlayers() });
    socCalls.connect(b);
    piBridge.addPusher(() => [socCalls.piMessage()]);
    socPlayers.onChange(() => piBridge.schedulePush());
    streamDeck.settings.onDidReceiveGlobalSettings((ev) => readGlobal(ev.settings as Record<string, unknown>));
    readGlobal(await streamDeck.settings.getGlobalSettings().catch(() => ({})));
    if (!(await b.start())) return;
    streamDeck.logger.info(`[deckbus] SO-C in slot ${b.slot}`);
    onDevicesChanged(shareStatus);
    shareStatus();
    // Group names like "Küche + 2", again whenever speakers join or leave groups
    const countMembers = () => setGroupMembers((id) => safeDevices().filter((d) => !isInvisibleSatellite(d.Host) && (d.Coordinator?.Uuid || d.Coordinator?.Host) === id).map((d) => d.Uuid || d.Host));
    onDevicesChanged(countMembers);
    countMembers();
    // Every group on deckbus, not only the speakers SO-C's own actions have open: the universal
    // keys (any plugin's) follow the active speaker and stopped ones too (seen 2026-10-09: a radio
    // started in the Sonos app only reached the deck late, through Music Assistant)
    onDevicesChanged(followGroups);
    followGroups();
}

/** The coordinator of every visible group, each held open while it leads its group. */
const followed = new Set<string>();
function followGroups(): void {
    const leaders = new Set(safeDevices().filter((d) => !isInvisibleSatellite(d.Host) && (!d.Coordinator || d.Coordinator.Host === d.Host)).map((d) => d.Host));
    for (const host of leaders) {
        if (followed.has(host)) continue;
        followed.add(host);
        sonosDeviceManager.getController(host).catch((e) => {
            followed.delete(host);
            streamDeck.logger.warn(`[deckbus] can't follow ${host}`, e);
        });
    }
    for (const host of [...followed]) {
        if (leaders.has(host)) continue;
        followed.delete(host);
        sonosDeviceManager.releaseController(host);
    }
}

function shareStatus(): void {
    const n = safeDevices().length;
    const status = { online: n > 0, detail: n ? `${n} Sonos speakers` : "no speakers found" };
    const json = JSON.stringify(status);
    if (!bus || json === lastStatus) return;
    lastStatus = json;
    bus.setState("status", status);
}
