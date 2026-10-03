// The speaker and group lists the settings panels choose from (the kit PI's <pi-select
// source="sonos-devices"/"sonos-groups">, served by src/pi/bridge.ts).

import { safeDevices, discoveryPromise, isInvisibleSatellite } from "../sonos/sonos-discovery";
import { piT } from "../utils/pi-i18n";

export type PiOptionItem = { label: string; value: string };

/** The speakers to choose from (also for the kit PI's `<pi-select source="sonos-devices">`). */
export async function deviceItems(currentIp?: string): Promise<PiOptionItem[]> {
    await discoveryPromise;
    const known = safeDevices();
    const visible = known.filter((d) => !isInvisibleSatellite(d.Host));
    const items: PiOptionItem[] = visible.map((d) => ({ label: d.Name, value: d.Host }));
    if (currentIp && !visible.some((d) => d.Host === currentIp)) {
        items.unshift({ label: `${currentIp} ${piT('(offline)')}`, value: currentIp });
    }
    return items;
}

/** The groups to choose from, keyed by coordinator host (also for `<pi-select source="sonos-groups">`). */
export async function groupItems(currentIp?: string): Promise<PiOptionItem[]> {
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
    return items;
}

