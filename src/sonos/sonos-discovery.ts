import streamDeck from "@elgato/streamdeck";
import { SonosManager, SonosEventListener, SonosDevice } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./SonosFavoritesCache";

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
const DISCOVERY_RETRY_MS = 20_000;

async function runDiscovery(): Promise<void> {
    try {
        await sonosManager.InitializeWithDiscovery();
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
        await sonosFavoritesCache.start(sonosManager.Devices[0]);
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
