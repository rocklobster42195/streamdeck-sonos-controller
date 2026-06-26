import streamDeck from "@elgato/streamdeck";
import { SonosManager, SonosEventListener } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./SonosFavoritesCache";

export const sonosManager = new SonosManager();

// Store the listener host after discovery.
export let eventListenerHost: string | undefined;

// Start discovery immediately, but don't block plugin initialization.
// Export the promise so other parts of the plugin can wait for it.
export const discoveryPromise = sonosManager.InitializeWithDiscovery()
    .then(async () => {
        const listenerStatus = SonosEventListener.DefaultInstance.GetStatus();
        if (listenerStatus) {
            eventListenerHost = listenerStatus.host;
        }
        streamDeck.logger.info(`Sonos device discovery completed. Found ${sonosManager.Devices.length} players.`);
        streamDeck.logger.info(`Using event listener host: ${eventListenerHost}`);
        sonosManager.Devices.forEach(d => {
            streamDeck.logger.info(`- ${d.Name} (${d.Host})`)
        })
        // If we found any devices, start the favorites cache using the first one.
        if (sonosManager.Devices.length > 0) {
            await sonosFavoritesCache.start(sonosManager.Devices[0]);
        }
    })
    .catch(err => {
        streamDeck.logger.error('Error during Sonos device discovery:', err);
    });

/**
 * A shared cache for Sonos favorites and their cover art.
 */
export { sonosFavoritesCache };
