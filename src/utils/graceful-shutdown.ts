import streamDeck from "@elgato/streamdeck";
// The SDK offers no public "Stream Deck closed the socket" event — its Connection never even
// registers an onclose handler. That close is exactly the moment Stream Deck stops or restarts
// the plugin (the process then has a short grace window before being force-killed), so hook the
// underlying WebSocket directly via the SDK-internal connection singleton. The deep relative
// import resolves to the SAME file the SDK's own index.js imports, so rollup dedupes it into one
// module instance; the package's `exports` field blocks the cleaner subpath specifier.
import { connection } from "../../node_modules/@elgato/streamdeck/dist/plugin/connection.js";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { sonosManager, sonosFavoritesCache } from "../sonos/sonos-discovery";

// Hard plugin kills (every `streamdeck restart` during development, Stream Deck quitting) used to
// leave all GENA subscriptions orphaned on the speakers — the lib subscribes with a hardcoded
// `Timeout: Second-3600`, so a speaker keeps NOTIFYing dead endpoints for up to an hour. That
// audibly degraded event delivery for the next plugin instance (covers/track changes then only
// arrived via the 8s/24s polls). Orphans whose NOTIFYs reach a NEW instance are self-healing (the
// event listener answers unknown SIDs with 412, which makes Sonos drop the subscription), but
// nothing heals them while nobody is listening — exactly the Stream Deck/PC shutdown case. So:
// send real UNSUBSCRIBEs in the grace window before the process dies.
const SHUTDOWN_BUDGET_MS = 2500;
// Favorites-cache/zone-topology UNSUBSCRIBEs are fired inside the lib on removeListener without
// a promise to await — keep the event loop alive briefly so those HTTP requests actually leave.
// Keep this short: measured on hardware, Stream Deck force-kills the process ~600ms after
// closing the websocket — a generous settle just means the kill lands mid-wait.
const SETTLE_MS = 150;

let shutdownStarted = false;

export function registerGracefulShutdown(): void {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
        try { process.on(signal, () => void shutdown(signal)); } catch { /* not supported on this platform */ }
    }
    void hookWebSocketClose();
}

async function hookWebSocketClose(): Promise<void> {
    try {
        // `connection.connection` is typed private — runtime access is a plain public class field.
        const conn = connection as unknown as { connection: { promise: Promise<{ on(ev: string, cb: () => void): void }> } };
        const ws = await conn.connection.promise;
        ws.on("close", () => void shutdown("websocket closed by Stream Deck"));
    } catch (e) {
        streamDeck.logger.warn("[shutdown] WebSocket close hook unavailable — relying on signal handlers only.", e);
    }
}

async function shutdown(reason: string): Promise<void> {
    if (shutdownStarted) return;
    shutdownStarted = true;
    streamDeck.logger.info(`[shutdown] ${reason} — unsubscribing UPnP event subscriptions...`);

    const work = (async () => {
        sonosFavoritesCache.stop(); // lib auto-UNSUBSCRIBEs ContentDirectory once the listener is removed
        try { sonosManager.CancelSubscription(); } catch { /* zone subscription may not exist yet */ }
        await sonosDeviceManager.cancelAllSubscriptions();
        // Logged BEFORE the settle wait — the force-kill (~600ms after socket close) usually lands
        // during the settle, so this is the line that proves the UNSUBSCRIBEs completed.
        streamDeck.logger.info("[shutdown] UNSUBSCRIBEs sent.");
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    })();

    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS))]);
    process.exit(0);
}
