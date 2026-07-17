import streamDeck from "@elgato/streamdeck";
import { SonosManager, SonosEventListener } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./SonosFavoritesCache";

export const sonosManager = new SonosManager();

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
