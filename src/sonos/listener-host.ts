import type { NetworkInterfaceInfo } from "node:os";

// Picks the local IPv4 address the speakers can actually send UPnP events (GENA NOTIFYs) to: the
// one whose subnet contains the speaker. The lib's own pick is simply "first non-internal IPv4 of
// the first interface", which on a PC with a VPN (UniFi Teleport, WireGuard, …) or a second NIC
// can be an address the speakers can't reach. Confirmed on hardware (2026-09-25): the plugin ran
// for ~18 h with the Teleport address 192.168.2.3 as its callback while the speakers lived in
// 192.168.7.0/24. Sonos delivers events to its subscribers one after another, so every event sat
// in a connect timeout on the dead callback first — Home Assistant and Music Assistant on the
// same speakers got their updates 20–40 s late, some never. Returns undefined when no local
// interface shares the speaker's subnet (then the speakers most likely can't reach us at all).
export function pickListenerHost(
    ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
    speakerIp: string,
): string | undefined {
    const speaker = ipv4ToInt(speakerIp);
    if (speaker === undefined) return undefined;
    for (const infos of Object.values(ifaces)) {
        for (const info of infos ?? []) {
            if (info.family !== "IPv4" || info.internal) continue;
            const addr = ipv4ToInt(info.address);
            const mask = ipv4ToInt(info.netmask);
            if (addr === undefined || mask === undefined || mask === 0) continue;
            if ((addr & mask) === (speaker & mask)) return info.address;
        }
    }
    return undefined;
}

function ipv4ToInt(ip: string): number | undefined {
    const parts = ip.split(".");
    if (parts.length !== 4) return undefined;
    let n = 0;
    for (const p of parts) {
        const v = Number(p);
        if (!Number.isInteger(v) || v < 0 || v > 255 || p === "") return undefined;
        n = n * 256 + v;
    }
    return n | 0; // signed 32-bit, matching what the & operator yields
}
