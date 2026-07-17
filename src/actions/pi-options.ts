// Shared Property-Inspector option lists. Every action used to build these inline in its own
// onSendToPlugin — 10 near-identical get-devices blocks, and byte-identical fade/align/viz/
// battery lists in up to 4 files each, which silently drifted apart (e.g. adding a fade step
// meant editing three files). One module, one list.
//
// Replies go through streamDeck.ui.sendToPropertyInspector, which targets the currently open
// PI — exactly what the inline versions did.

import streamDeck from "@elgato/streamdeck";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { effectRegistry } from "../effects/registry.generated";
import { piT } from "../utils/pi-i18n";

export type PiOptionItem = { label: string; value: string };

export function sendOptions(event: string, items: PiOptionItem[]): void {
    streamDeck.ui.sendToPropertyInspector({ event, items });
}

/** Device dropdown ('get-devices'). Waits for discovery so the list is never empty-by-race. */
export async function sendDeviceList(placeholderKey = '-- Choose device --'): Promise<void> {
    await discoveryPromise;
    const items = sonosManager.Devices.map((d) => ({ label: d.Name, value: d.Host }));
    sendOptions('get-devices', [{ label: piT(placeholderKey), value: '' }, ...items]);
}

/** Group dropdown ('get-groups') — one entry per current zone group, keyed by coordinator host. */
export async function sendGroupList(): Promise<void> {
    await discoveryPromise;
    const seen = new Set<string>();
    const items: PiOptionItem[] = [];
    for (const d of sonosManager.Devices) {
        const coordinator = d.Coordinator ?? d;
        if (seen.has(coordinator.Host)) continue;
        seen.add(coordinator.Host);
        items.push({ label: d.GroupName ?? coordinator.Name, value: coordinator.Host });
    }
    sendOptions('get-groups', [{ label: piT('-- Choose group --'), value: '' }, ...items]);
}

export function sendFadeOptions(): void {
    sendOptions('get-fade-options', [
        { label: piT('Off'), value: '0' },
        { label: '2 s', value: '2' },
        { label: '3 s', value: '3' },
        { label: '5 s', value: '5' },
        { label: '8 s', value: '8' },
    ]);
}

export function sendAlignOptions(): void {
    sendOptions('get-align-options', [
        { label: piT('Left'), value: 'left' },
        { label: piT('Center'), value: 'center' },
        { label: piT('Right'), value: 'right' },
    ]);
}

/** Visualizer dropdown ('get-viz-options'): action-specific baseline entries (e.g. 'None',
 *  Track Dial's 'EQ Effect', Favorites' 'Cover mosaic'), then every registered effect. */
export function sendVizOptions(...baseline: PiOptionItem[]): void {
    sendOptions('get-viz-options', [
        ...baseline,
        ...[...effectRegistry.values()].map(def => ({ label: piT(def.displayName), value: def.id })),
    ]);
}

export function sendBatteryModeOptions(): void {
    sendOptions('get-battery-mode-options', [
        { label: piT('Off'), value: 'off' },
        { label: piT('Warning (low battery only)'), value: 'warning' },
        { label: piT('Always'), value: 'full' },
    ]);
}
