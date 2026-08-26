// Shared Property-Inspector option lists. Every action used to build these inline in its own
// onSendToPlugin — 10 near-identical get-devices blocks, and byte-identical fade/align/viz/
// battery lists in up to 4 files each, which silently drifted apart (e.g. adding a fade step
// meant editing three files). One module, one list.
//
// Replies go through streamDeck.ui.sendToPropertyInspector, which targets the currently open
// PI — exactly what the inline versions did.

import streamDeck from "@elgato/streamdeck";
import { safeDevices, discoveryPromise, onDevicesChanged, isInvisibleSatellite } from "../sonos/sonos-discovery";
import { effectRegistry } from "../effects/registry.generated";
import { piT } from "../utils/pi-i18n";

export type PiOptionItem = { label: string; value: string };

export function sendOptions(event: string, items: PiOptionItem[]): void {
    streamDeck.ui.sendToPropertyInspector({ event, items });
}

/** Device dropdown ('get-devices'). Waits for discovery so the list is never empty-by-race.
 *  Resolves to an empty list (not a crash) if discovery never succeeded — see safeDevices().
 *
 *  `currentIp`, when given, is the action instance's OWN currently-configured deviceIp — pass it
 *  whenever a specific action instance is asking (i.e. every real onSendToPlugin 'get-devices'
 *  case), not from the generic onDevicesChanged re-push below, which has no single instance to
 *  ask. If that device isn't in the current (filtered) list (e.g. a battery speaker asleep or off
 *  its charger, or one already pointed at an invisible satellite from before this filter existed),
 *  it's kept as its own option instead of silently dropped — confirmed on hardware (2026-07-18):
 *  sdpi-select's bound value falling out of its own <option> list makes it reset to the blank
 *  placeholder and write THAT back through the settings-sync channel, silently wiping a
 *  still-valid deviceIp just because the device happened to be temporarily unreachable (or, now,
 *  filtered) at the exact moment the PI was opened. */
export async function sendDeviceList(placeholderKey = '-- Choose device --', currentIp?: string): Promise<void> {
    await discoveryPromise;
    const known = safeDevices();
    const visible = known.filter((d) => !isInvisibleSatellite(d.Host));
    const items: PiOptionItem[] = visible.map((d) => ({ label: d.Name, value: d.Host }));
    if (currentIp && !visible.some((d) => d.Host === currentIp)) {
        items.unshift({ label: `${currentIp} ${piT('(offline)')}`, value: currentIp });
    }
    sendOptions('get-devices', [{ label: piT(placeholderKey), value: '' }, ...items]);
}

/** Group dropdown ('get-groups') — one entry per current zone group, keyed by coordinator host.
 *  `currentIp` — see sendDeviceList's doc comment; same reasoning applies here (a group whose
 *  anchor is a battery speaker currently asleep would otherwise vanish from the list and get
 *  silently reset). */
export async function sendGroupList(currentIp?: string): Promise<void> {
    await discoveryPromise;
    const known = safeDevices();
    const seen = new Set<string>();
    const items: PiOptionItem[] = [];
    for (const d of known) {
        const coordinator = d.Coordinator ?? d;
        if (seen.has(coordinator.Host)) continue;
        seen.add(coordinator.Host);
        // Recomputed ourselves rather than trusting d.GroupName — the library's own "+N" suffix
        // counts EVERY zone member, including a bonded stereo/HT pair's invisible satellite, so a
        // group containing one or more bonded rooms would otherwise show an inflated count (e.g.
        // "Herrenzimmer + 8" instead of "+6" for a 7-room group with 2 bonded pairs). Same fix as
        // SonosGroupController.resolveCoordinator()'s dial-face group name.
        const memberCount = known
            .filter((m) => (m.Coordinator ?? m).Host === coordinator.Host)
            .filter((m) => !isInvisibleSatellite(m.Host))
            .length;
        const label = memberCount > 1 ? `${coordinator.Name} + ${memberCount - 1}` : coordinator.Name;
        items.push({ label, value: coordinator.Host });
    }
    if (currentIp && !seen.has(currentIp)) {
        items.unshift({ label: `${currentIp} ${piT('(offline)')}`, value: currentIp });
    }
    sendOptions('get-groups', [{ label: piT('-- Choose group --'), value: '' }, ...items]);
}

// Re-push both dropdowns to whichever PI is currently open once a delayed discovery succeeds —
// see onDevicesChanged's own comment in sonos-discovery.ts for the "device list doesn't load
// cleanly after a restart" symptom this fixes: a PI opened right at plugin startup can race
// against a still-failing/in-flight first discovery attempt and get sent an empty list, with
// nothing ever re-populating it once discovery actually lands a few seconds/retries later.
// Always uses the default placeholder text — the one action with a different placeholder
// (Panorama Effects' "-- No device (static color) --") would only show the generic one for the
// rare case where ITS PI happens to be open at that exact moment, a cosmetic edge case not worth
// threading a placeholder override through this generic hook.
onDevicesChanged(() => {
    void sendDeviceList();
    void sendGroupList();
});

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
