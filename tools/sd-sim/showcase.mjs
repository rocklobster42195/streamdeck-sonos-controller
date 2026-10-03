// Staged screenshots for the README and the Marketplace (from Music Assistant Controller): the
// real plugin against a stand-in Sonos system (fake-sonos.mjs) — invented rooms, tracks and
// favorites, generated covers, no lyrics. Plays nothing anywhere, never touches real speakers.
// Writes deck overviews to sim-out/showcase/.
//   node tools/sd-sim/showcase.mjs [outDir]
import path from "node:path";
import { startFakeSonos } from "./fake-sonos.mjs";
import { startSim } from "./sim.mjs";

// The plugin's UPnP event listener must not collide with a running SO-C
process.env.SONOS_LISTENER_PORT ??= "6351";

const out = path.resolve(process.argv[2] ?? "sim-out");
const sonos = await startFakeSonos();
const LIVING = "127.0.0.2";
/** A favorite as the Play Favorite key stores it (the cover is found by its AlbumArtUri). */
const FAVORITE = JSON.stringify({ Title: "Evening Jazz", AlbumArtUri: "http://127.0.0.2:1400/getaa?s=1&u=demo-dusk", TrackUri: "x-rincon-cpcontainer:1006206cdemo0" });

/** One scene: a fresh deck with `build`'s actions, snapshotted after `settleMs`. */
async function scene(name, build, settleMs = 9000, after) {
    const sim = await startSim({ language: "en", globalSettings: { lastKnownDeviceIp: sonos.seedIp, householdId: sonos.household } });
    try {
        const ctx = build(sim);
        await sim.sleep(settleMs);
        if (after) await after(sim, ctx);
        const file = await sim.snapshot(out, name);
        console.log("wrote", file);
    } finally {
        await sim.stop();
    }
}

const key = (sim, suffix, settings, column, row) => sim.add(suffix, settings, { column, row });
const dial = (sim, suffix, settings, column) => sim.add(suffix, settings, { column, controller: "Encoder" });

/** The everyday keys: transport on top, volume below. */
function keys(sim) {
    key(sim, "playback-control-key", { deviceIp: LIVING, command: "previous" }, 0, 0);
    key(sim, "play-pause-key", { deviceIp: LIVING, showTrackTitle: true, showProgress: true }, 1, 0);
    key(sim, "playback-control-key", { deviceIp: LIVING, command: "next" }, 2, 0);
    key(sim, "playback-control-key", { deviceIp: LIVING, command: "shuffle" }, 3, 0);
    key(sim, "volume-control-key", { deviceIp: LIVING, command: "vol-down" }, 0, 1);
    key(sim, "volume-control-key", { deviceIp: LIVING, command: "mute", presetVolume: 20 }, 1, 1);
    key(sim, "volume-control-key", { deviceIp: LIVING, command: "vol-up" }, 2, 1);
    key(sim, "play-favorite-key", { deviceIp: LIVING, showTitle: true, favorite: FAVORITE }, 3, 1);
}

const scenes = {
    // The dials as you'd use them every day, with a Panorama effect across the row
    "01-everyday": () => scene("01-everyday", (sim) => {
        keys(sim);
        dial(sim, "track-control-dial", { deviceIp: LIVING, panoramaMember: true }, 0);
        dial(sim, "volume-dial", { deviceIp: LIVING, gauge: "ring", panoramaMember: true }, 1);
        dial(sim, "queue-dial", { deviceIp: LIVING, panoramaMember: true }, 2);
        dial(sim, "favorites-dial", { deviceIp: LIVING, panoramaMember: true }, 3);
    }),
    // Browsing: the Favorites list (turned once) next to the Queue list
    "02-lists": () => scene("02-lists", (sim) => {
        keys(sim);
        dial(sim, "group-volume-dial", { groupIp: LIVING, panoramaMember: false }, 0);
        dial(sim, "volume-dial", { deviceIp: "127.0.0.4", gauge: "open", panoramaMember: false }, 1);
        dial(sim, "queue-dial", { deviceIp: LIVING, panoramaMember: false }, 2);
        return { fav: dial(sim, "favorites-dial", { deviceIp: LIVING, panoramaMember: false }, 3) };
    }, 9000, async (sim, ctx) => {
        sim.rotate(ctx.fav, 1);
        await sim.sleep(1500);
    }),
    // The Panorama on its own: four Panorama Effects dials, title and artist across them
    "03-panorama": () => scene("03-panorama", (sim) => {
        keys(sim);
        for (let c = 0; c < 4; c++) dial(sim, "panorama-effects-dial", { deviceIp: LIVING, showTrackInfo: true, effectId: "particles" }, c);
    }, 10000),
    // The volume looks side by side
    "04-volume-looks": () => scene("04-volume-looks", (sim) => {
        keys(sim);
        dial(sim, "volume-dial", { deviceIp: LIVING, gauge: "pie", panoramaMember: false }, 0);
        dial(sim, "volume-dial", { deviceIp: "127.0.0.3", gauge: "ring", icon: "mdiSilverwareForkKnife", panoramaMember: false }, 1);
        dial(sim, "volume-dial", { deviceIp: "127.0.0.4", gauge: "open", icon: "mdiDesk", panoramaMember: false }, 2);
        dial(sim, "group-volume-dial", { groupIp: LIVING, gauge: "ring", align: "center", panoramaMember: false }, 3);
    }),
};

try {
    const only = process.argv[3];
    for (const [name, run] of Object.entries(scenes)) if (!only || name.startsWith(only)) await run();
} finally {
    await sonos.stop();
}
process.exit(0);
