import { sonosManager, discoveryPromise } from "./sonos-discovery";

/** Whether a device (by IP, as stored in `deviceIp` settings) actually has a physical Line-In
 *  input. Probes the read-only `AudioInService.GetLineInLevel()` getter (NOT `SwitchToLineIn`,
 *  which actually switches the audio source) — every `SonosDevice` exposes an `AudioInService`
 *  property regardless of hardware, so its mere existence proves nothing; the getter call itself
 *  is expected to throw a UPnP error on a device without the port. **Not yet verified against real
 *  hardware** — built from `@svrooij/sonos`'s SDK docs/typings only (see
 *  https://sonos-ts.svrooij.io/sonos-device/services/audio-in-service.html), same shape as the
 *  proven `deviceHasBattery()` in SonosBattery.ts (backend-to-device SOAP call, not the PI-side
 *  messaging hack that caused problems previously — see that module's sibling doc comment). Never
 *  throws: discovery-lookup failures and any GetLineInLevel error both resolve to `false`, same
 *  "not available" contract as deviceHasBattery. */
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
