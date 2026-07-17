import { sonosManager, discoveryPromise } from "./sonos-discovery";

/** Whether a device (by IP, as stored in `deviceIp` settings) actually has a physical Line-In
 *  input. Probes the read-only `AudioInService.GetLineInLevel()` getter (NOT `SwitchToLineIn`,
 *  which actually switches the audio source) — every `SonosDevice` exposes an `AudioInService`
 *  property regardless of hardware, so its mere existence proves nothing; the getter call itself
 *  throws on a device without the port. **Hardware-verified 2026-07-17** against 8 live devices
 *  (local/test-line-in.mjs): a Sonos Port answers with left/right levels (~40ms), while Play:1,
 *  One, One SL, Play:3 and SYMFONISK all fail fast with HTTP 500 (~10ms) — so the probe is both
 *  correct and cheap in the negative case. Same shape as the proven `deviceHasBattery()` in
 *  SonosBattery.ts (backend-to-device SOAP call, not the PI-side messaging hack that caused
 *  problems previously). Never throws: discovery-lookup failures and any GetLineInLevel error
 *  both resolve to `false`, same "not available" contract as deviceHasBattery. */
export async function deviceHasLineIn(deviceIp: string | undefined): Promise<boolean> {
    if (!deviceIp) return false;
    try {
        await discoveryPromise;
        const device = sonosManager.Devices.find(d => d.Host === deviceIp);
        if (!device) return false;
        await device.AudioInService.GetLineInLevel();
        return true;
    } catch {
        return false;
    }
}
