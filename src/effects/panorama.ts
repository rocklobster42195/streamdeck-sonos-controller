// The plugin's one Panorama, from the kit: effects spanning neighbouring dials, one effect per row
// of dials (the kit's PanoramaRows), chosen in the PI's Panorama section. Shared over deckbus with
// other plugins' dials in the same row (src/bus/soc-bus.ts); the kit tracks where the dials are.
//
// Replaces the plugin's own PanoramaOrchestrator. The dials keep calling the helpers at the bottom
// (same names as the orchestrator's), so their drawing code didn't have to change.
import { socCovers } from "../bus/soc-covers";
import { ActionsState } from "@rocklobster42195/streamdeck-kit/bus";
import { PanoramaEngine, PanoramaRows, rowStateFromSettings, SharedPanorama, type RowDialState } from "@rocklobster42195/streamdeck-kit";

let sink: ((key: string, value: unknown) => void) | undefined;

/** Where the plugin's actions are (fed by the kit's trackActions), shared on deckbus once it runs. */
export const socActions = new ActionsState({ setState: (key, value) => sink?.(key, value) });

/** The bus takes over the "actions" state (called once it exists). */
export function shareActionsTo(fn: (key: string, value: unknown) => void): void {
    sink = fn;
}

export const panorama = new SharedPanorama(new PanoramaEngine({ defaultColor: "#404040" }), socActions);

/** One effect per row, with the row's colour (the cover of a speaker from SO-C's or another plugin's "covers" on deckbus). */
export const panoramaRows = new PanoramaRows(panorama, { name: "SO-C", actions: socActions, covers: socCovers });

/** Stream Deck sends {} for a dial that was just placed and never configured. */
export function isFresh(settings: object): boolean {
    return Object.keys(settings).length === 0;
}

/**
 * A dial's row state from its settings: the kit's `panorama`/`panoramaMember` once set; before that
 * the old per-dial choice — an effect in `visualizerMode` (the Panorama Effects dial: `effectId`)
 * becomes the row's effect with its flat tuning fields, a non-effect mode leaves the dial out
 * (its look stays as it was). The old keys stay in the settings (downgrade-safe).
 *
 * Within a row the newest choice wins and, at equal age, the left dial; old choices get stamp 1,
 * the Panorama Effects dial's stamp 2, so its effect wins its row (migration grill, Q5).
 */
export function socRowState(settings: Record<string, unknown>, oldEffect: string | undefined, effectsDial = false): RowDialState {
    if (settings.panorama !== undefined || typeof settings.panoramaMember === "boolean") return rowStateFromSettings(settings);
    if (isFresh(settings)) return { member: true };
    const state = rowStateFromSettings({ ...settings, background: oldEffect ?? "none" });
    if (effectsDial && state.row && state.row.stamp <= 1) state.row = { ...state.row, stamp: 2 };
    return state;
}

// ---- the orchestrator's helper names, on the kit's Panorama ----------------------------------

/** The dial's key in the Panorama while it shows an effect (undefined otherwise). */
export const panoramaContextGroupKey = {
    get(context: string): string | undefined {
        return panoramaRows.isMember(context) && panoramaRows.effectOf(context) && panorama.isActive(context) ? context : undefined;
    },
};

/** Whether a key from panoramaContextGroupKey shows an effect. */
export function isPanoramaEffectActive(key: string | undefined): key is string {
    return !!key;
}

/** The dial's slice of its row's effect (the kit positions it; `offsetX` is no longer needed). */
export function renderPanoramaEffectSlice(key: string | undefined, _offsetX = 0): string {
    return key ? panorama.renderSlice(key) : "";
}

/** Kept for the callers' signatures; the kit knows each dial's place in the row. */
export function getPanoramaSliceOffset(_context: string): number {
    return 0;
}

