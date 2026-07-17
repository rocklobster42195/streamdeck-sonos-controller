import { sonosManager, discoveryPromise } from "./sonos-discovery";
import { withTimeout } from "../utils/with-timeout";

// An unreachable/flaky device's GetLineInLevel can otherwise hang for the OS-level TCP connect
// timeout (20-30s+ on Windows — same class of bug already fixed in SonosGroupController's
// getBaselineVolume and documented at length on SonosDeviceController's SET_VOLUME_TIMEOUT_MS).
// Both callers (FavoritesDial's onInstanceUpdate, MultiControlKey's onInstanceUpdate) run this
// fire-and-forget on every settings sync, so an unbounded hang here doesn't block first paint —
// but it does mean the capability check (and hence the PI's hasLineIn-gated UI) never settles for
// a device that's slow/flaky rather than cleanly rejecting, which reads as "stuck"/"laggy" on
// that specific tile. Confirmed fast in practice on hardware (~10ms negative, ~40ms positive —
// see local/test-line-in.mjs) but only for devices that actually answer; this bounds the case
// where one doesn't.
const LINE_IN_PROBE_TIMEOUT_MS = 4000;

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
        await withTimeout(device.AudioInService.GetLineInLevel(), LINE_IN_PROBE_TIMEOUT_MS, `GetLineInLevel (${deviceIp})`);
        return true;
    } catch {
        return false;
    }
}
