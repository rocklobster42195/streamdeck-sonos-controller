import streamDeck from "@elgato/streamdeck";
import { SonosManager, SonosEventListener, SonosDevice } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./SonosFavoritesCache";
import { withTimeout } from "../utils/with-timeout";

// A cached IP that's gone stale (device replaced, moved networks) can otherwise hang for the
// OS-level TCP connect timeout instead of failing fast — same reasoning as every other
// withTimeout use in this codebase.
const CACHED_IP_TIMEOUT_MS = 6000;

export const sonosManager = new SonosManager();

// SonosManager's own `.Devices` getter THROWS ("No Devices available!") whenever its internal
// list is empty — not just before discovery has ever run, but for the entire lifetime of any
// session where discovery keeps failing (e.g. SSDP multicast blocked by a VPN adapter taking
// over the default route — confirmed as the trigger 2026-07-17: WireGuard was active). Every
// PI-facing caller used to read `sonosManager.Devices` directly; a couple of call sites
// (pi-options.ts's sendDeviceList/sendGroupList, SonosGroupController's resolveCoordinator) had
// no try/catch around that read at all. The @elgato/streamdeck SDK only installs a ONE-SHOT
// `process.once('uncaughtException', ...)` handler (logs and survives the first escape, but is
// then gone) — so the first uncaught throw from this getter was survivable, but ANY second one
// crashed the entire plugin process with no further logging, hanging every action's PI
// simultaneously (not just the one that happened to trigger it) until a manual restart. This
// safe wrapper is now the only sanctioned way to read the device list.
export function safeDevices(): SonosDevice[] {
    try {
        return sonosManager.Devices;
    } catch {
        return [];
    }
}

// Listener host after discovery — module-internal, only used for the startup log below.
let eventListenerHost: string | undefined;

// A failed SSDP discovery is retried until it succeeds. Without this, one bad round at plugin
// start ("No players found" — seen on hardware right after a plugin restart) left the entire
// session with an empty sonosManager: no PI device lists, and — much worse — no group topology,
// so a grouped member's transportDevice fell back to the member itself and every cover fetch for
// it 404'd against the member's own /getaa (observed as "grouped Roam never gets a cover").
//
// 5s, not the original 20s: each retry's own InitializeWithDiscovery(10) already spends up to 10s
// waiting for a response before giving up (SearchOne's default timeout — left untouched here,
// since it resolves near-instantly once ANY device answers, and shortening it would risk giving
// up on a genuinely-just-slow-to-respond network before it gets a chance). Confirmed via the
// plugin's own log (2026-07-17): a real run needed 3 attempts — 10s fail, 20s wait, 10s fail, 20s
// wait, ~6s success — 66s total before ANY PI device dropdown could populate. The 20s gap between
// attempts had no empirical basis (SSDP M-SEARCH retries are cheap, lightweight UDP broadcasts,
// not worth throttling this conservatively on a home LAN) — 5s cuts the same 3-attempt worst case
// to roughly 30s.
const DISCOVERY_RETRY_MS = 5_000;

// Fired every time discovery actually succeeds — including a LATER retry after the first attempt
// failed. discoveryPromise only ever waits for that first attempt (see its own comment below), so
// any PI that requested its device/group dropdown right at plugin startup and raced against a
// failed or still-in-flight first attempt was sent an empty list and never got another one —
// observed as "devices don't load cleanly after a restart" (the dropdown just shows the
// placeholder forever, even though sonosManager fills in correctly a few seconds later). Letting
// pi-options.ts re-push both lists once discovery actually lands repairs that dropdown without
// the user having to close and reopen the PI.
const devicesChangedListeners = new Set<() => void>();

export function onDevicesChanged(cb: () => void): void {
    devicesChangedListeners.add(cb);
}

interface DiscoveryGlobalSettings {
    [key: string]: string | undefined;
    lastKnownDeviceIp?: string;
}

// SSDP discovery depends on UDP multicast/broadcast responses actually reaching this process —
// confirmed on hardware (2026-07-18): after a laptop sleep/wake cycle, Windows can reclassify the
// network as "Public" and silently block inbound SSDP responses while normal outbound HTTP keeps
// working fine (direct requests to every known device IP succeeded even though SSDP discovery
// failed for 10+ minutes straight). InitializeFromDevice() bypasses SSDP entirely — it's a plain
// HTTP/SOAP call to one known IP, which then pulls the full household topology the same way
// InitializeWithDiscovery does internally. Caching the last successfully-used IP and trying it
// FIRST means a repeat of that exact scenario recovers on its own, without the user needing to
// fix their network profile or restart the plugin — falls through to normal SSDP discovery if the
// cached IP is stale/gone (device replaced, moved to a new network, first-ever run, etc).
// Called by any SonosDeviceController the moment ITS OWN direct (non-discovery) communication
// with a device succeeds — independent of whether sonosManager/SSDP has ever worked this session.
// Without this, the cache could only ever be seeded by a successful sonosManager-based discovery,
// which is exactly the thing failing — a chicken-and-egg deadlock confirmed on hardware
// (2026-07-18): individual dials worked fine all session (their configured device answered direct
// HTTP calls just fine) while sonosManager/SSDP kept failing and favorites never loaded (favorites
// cache only starts from a successful discovery), yet nothing ever primed the fallback because
// discovery itself never got the one success it needed. Seeding it from ANY working controller
// breaks that: the next retry (at most DISCOVERY_RETRY_MS away) tries this IP via
// InitializeFromDevice and recovers immediately, with no restart and no OS-level network fix
// needed.
export function noteReachableDeviceIp(ip: string): void {
    streamDeck.settings.setGlobalSettings<DiscoveryGlobalSettings>({ lastKnownDeviceIp: ip })
        .catch((e) => streamDeck.logger.debug('Failed to cache reachable device IP', e));
}

async function tryFromCachedIp(): Promise<boolean> {
    let cachedIp: string | undefined;
    try {
        const settings = await streamDeck.settings.getGlobalSettings<DiscoveryGlobalSettings>();
        cachedIp = settings.lastKnownDeviceIp;
    } catch { /* ignore — fall through to SSDP */ }
    if (!cachedIp) return false;

    try {
        await withTimeout(sonosManager.InitializeFromDevice(cachedIp), CACHED_IP_TIMEOUT_MS, `InitializeFromDevice (${cachedIp})`);
        return sonosManager.Devices.length > 0;
    } catch {
        return false;
    }
}

async function runDiscovery(): Promise<void> {
    try {
        if (!await tryFromCachedIp()) {
            await sonosManager.InitializeWithDiscovery();
        }
        if (sonosManager.Devices.length === 0) throw new Error('Discovery returned no players');

        const listenerStatus = SonosEventListener.DefaultInstance.GetStatus();
        if (listenerStatus) {
            eventListenerHost = listenerStatus.host;
        }
        streamDeck.logger.info(`Sonos device discovery completed. Found ${sonosManager.Devices.length} players.`);
        streamDeck.logger.info(`Using event listener host: ${eventListenerHost}`);
        sonosManager.Devices.forEach(d => {
            streamDeck.logger.info(`- ${d.Name} (${d.Host})`);
        });
        noteReachableDeviceIp(sonosManager.Devices[0].Host);
        await sonosFavoritesCache.start(sonosManager.Devices[0]);
        devicesChangedListeners.forEach(cb => cb());
    } catch (err) {
        streamDeck.logger.error(`Sonos discovery failed — retrying in ${DISCOVERY_RETRY_MS / 1000}s:`, err);
        setTimeout(() => void runDiscovery(), DISCOVERY_RETRY_MS);
    }
}

// Start discovery immediately, but don't block plugin initialization.
// Export the promise so other parts of the plugin can wait for it. Resolves after the FIRST
// attempt either way (so PI device lists don't hang forever on a bad network) — later retries
// fill sonosManager in the background.
export const discoveryPromise = runDiscovery();

/**
 * A shared cache for Sonos favorites and their cover art.
 */
export { sonosFavoritesCache };
