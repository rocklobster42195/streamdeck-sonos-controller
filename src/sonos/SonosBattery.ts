import { SonosDevice } from "@svrooij/sonos";
import { withTimeout } from "../utils/fetchWithTimeout";
import { sonosManager, discoveryPromise } from "./sonos-discovery";

const FETCH_TIMEOUT_MS = 4000;

export interface SonosBatteryStatus {
    /** 0-100, rounded (Sonos' own `BattPct`, not the finer-grained `RawBattPct`). */
    percent: number;
    charging: boolean;
}

function parseMoreInfo(moreInfo: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const pair of moreInfo.split(',')) {
        const idx = pair.indexOf(':');
        if (idx === -1) continue;
        fields[pair.substring(0, idx).trim()] = pair.substring(idx + 1).trim();
    }
    return fields;
}

/** Parses the `MoreInfo` attribute Sonos attaches to a device's own <ZoneGroupMember> entry in
 *  ZoneGroupState. Only battery-capable speakers (Roam/Move) populate it with battery fields
 *  (confirmed on hardware: `RawBattPct:99,BattPct:100,BattChg:CHARGING,BattTmp:24`); mains-powered
 *  speakers report no MoreInfo or an unrelated one (e.g. `TargetRoomName:...`), so this returns
 *  undefined for those — callers use that to hide battery UI entirely on non-battery devices.
 *  Note: BattChg only ever says CHARGING/NOT_CHARGING — Sonos does not report whether a charge is
 *  coming from the wireless base or a USB-C cable, so that distinction cannot be surfaced. */
export function parseBatteryStatus(moreInfo: string | undefined): SonosBatteryStatus | undefined {
    if (!moreInfo) return undefined;
    const fields = parseMoreInfo(moreInfo);
    const percent = Number(fields.BattPct);
    if (!Number.isFinite(percent)) return undefined;
    return { percent, charging: fields.BattChg === 'CHARGING' };
}

/** Fetches one device's own battery status via the undocumented `MoreInfo` ZoneGroupMember
 *  attribute — the only place svrooij/sonos surfaces it, since its typed member parser strips
 *  MoreInfo out entirely (see zone-group-topology.service.extension.js ParseMember). Unofficial:
 *  Sonos could change or remove it in a firmware update without notice. Never throws — returns
 *  undefined on any fetch/parse failure, same as a non-battery device. */
export async function fetchBatteryStatus(sonosDevice: SonosDevice, deviceIp: string): Promise<SonosBatteryStatus | undefined> {
    try {
        const response = await withTimeout(
            sonosDevice.ZoneGroupTopologyService.GetZoneGroupState(),
            FETCH_TIMEOUT_MS,
            `battery status fetch (${deviceIp})`,
        );
        const xml = typeof response.ZoneGroupState === 'string' ? response.ZoneGroupState : '';
        const memberRegex = /<ZoneGroupMember\b[^>]*\/>/g;
        let match: RegExpExecArray | null;
        while ((match = memberRegex.exec(xml)) !== null) {
            const tag = match[0];
            if (!tag.includes(`Location="http://${deviceIp}:`)) continue;
            const moreInfoMatch = tag.match(/MoreInfo="([^"]*)"/);
            return parseBatteryStatus(moreInfoMatch?.[1]);
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/** Whether a device (by IP, as stored in `deviceIp` settings) currently reports battery data at
 *  all — used to gate the battery-mode PI dropdown so it's only offered for battery-capable
 *  speakers (Roam/Move), not every mains-powered Sonos device. Never throws: `sonosManager.Devices`
 *  throws "No Devices available!" until discovery finishes, which raced with every dial's own
 *  onWillAppear at plugin startup and aborted the rest of its init (cover/transport-state fetch)
 *  before this was made defensive — awaiting discoveryPromise plus a catch-all guards both that
 *  and any other discovery-lookup failure the same way fetchBatteryStatus already treats a fetch
 *  failure: as "no battery", not a hard error. */
export async function deviceHasBattery(deviceIp: string | undefined): Promise<boolean> {
    if (!deviceIp) return false;
    try {
        await discoveryPromise;
        const device = sonosManager.Devices.find(d => d.Host === deviceIp);
        if (!device) return false;
        const status = await fetchBatteryStatus(device, deviceIp);
        return status !== undefined;
    } catch {
        return false;
    }
}
