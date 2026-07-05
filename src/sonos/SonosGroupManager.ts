import streamDeck from "@elgato/streamdeck";
import { SonosGroupController } from "./SonosGroupController";

type ControllerEntry = {
    controller: SonosGroupController;
    refCount: number;
};

// Refcounted cache keyed by the anchor IP that was selected in the Property Inspector — mirrors
// SonosDeviceManager. Multiple GroupVolumeDial instances pointed at the same anchor share one
// SonosGroupController (and thus one topology-poll/event-subscription).
class SonosGroupManager {
    private controllerEntries: Map<string, ControllerEntry> = new Map();
    private pendingInitializations: Map<string, Promise<SonosGroupController>> = new Map();
    // Counts releaseController() calls that arrived while a getController() for the same anchor
    // was still initializing — without this, such a release found no entry yet and was silently
    // dropped, leaking the controller (and its member connections/timers) forever. See
    // SonosDeviceManager for the same fix and feedback-volume-dial-animation-tuning memory.
    private pendingReleases: Map<string, number> = new Map();

    public async getController(anchorIp: string): Promise<SonosGroupController> {
        const entry = this.controllerEntries.get(anchorIp);
        if (entry) {
            entry.refCount++;
            streamDeck.logger.debug(`[SonosGroupManager] Reusing existing controller for anchor: ${anchorIp}. New refCount: ${entry.refCount}`);
            return entry.controller;
        }

        const pending = this.pendingInitializations.get(anchorIp);
        if (pending) {
            streamDeck.logger.debug(`[SonosGroupManager] Waiting for pending controller initialization for anchor: ${anchorIp}`);
            const controller = await pending;
            const newEntry = this.controllerEntries.get(anchorIp);
            if (newEntry) {
                newEntry.refCount++;
                streamDeck.logger.debug(`[SonosGroupManager] Reusing existing controller for anchor: ${anchorIp}. New refCount: ${newEntry.refCount}`);
            } else {
                // Controller was released and destroyed in the meantime — restart the process.
                return this.getController(anchorIp);
            }
            return controller;
        }

        const promise = (async () => {
            try {
                streamDeck.logger.debug(`[SonosGroupManager] Creating new controller for anchor: ${anchorIp}`);
                const controller = new SonosGroupController(anchorIp);
                await controller.initialize();

                const queuedReleases = this.pendingReleases.get(anchorIp) ?? 0;
                this.pendingReleases.delete(anchorIp);
                const refCount = 1 - queuedReleases;
                if (refCount <= 0) {
                    streamDeck.logger.debug(`[SonosGroupManager] Controller for anchor: ${anchorIp} was released before initialization finished — destroying immediately.`);
                    controller.destroy();
                    return controller;
                }

                this.controllerEntries.set(anchorIp, { controller, refCount });
                return controller;
            } finally {
                this.pendingInitializations.delete(anchorIp);
            }
        })();

        this.pendingInitializations.set(anchorIp, promise);

        return promise;
    }

    public releaseController(anchorIp: string): void {
        const entry = this.controllerEntries.get(anchorIp);
        if (entry) {
            entry.refCount = Math.max(0, entry.refCount - 1);
            streamDeck.logger.debug(`[SonosGroupManager] Released controller for anchor: ${anchorIp}. New refCount: ${entry.refCount}`);
            if (entry.refCount <= 0) {
                streamDeck.logger.debug(`[SonosGroupManager] Destroying controller for anchor: ${anchorIp} as refCount is zero.`);
                entry.controller.destroy();
                this.controllerEntries.delete(anchorIp);
            }
            return;
        }

        if (this.pendingInitializations.has(anchorIp)) {
            this.pendingReleases.set(anchorIp, (this.pendingReleases.get(anchorIp) ?? 0) + 1);
            streamDeck.logger.debug(`[SonosGroupManager] Queued release for anchor: ${anchorIp} — initialization still in flight.`);
            return;
        }

        streamDeck.logger.warn(`[SonosGroupManager] Attempted to release a controller for an unknown anchor: ${anchorIp}`);
    }
}

export const sonosGroupManager = new SonosGroupManager();
