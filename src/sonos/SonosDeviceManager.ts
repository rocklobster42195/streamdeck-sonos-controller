import streamDeck from "@elgato/streamdeck";
import { SonosDeviceController } from "./SonosDeviceController";

type ControllerEntry = {
    controller: SonosDeviceController;
    refCount: number;
};

class SonosDeviceManager {
    private controllerEntries: Map<string, ControllerEntry> = new Map();
    private pendingInitializations: Map<string, Promise<SonosDeviceController>> = new Map();
    // Counts releaseController() calls that arrived while a getController() for the same IP was
    // still initializing. Without this, such a release found no entry yet (only created once
    // initialize() resolves) and was silently dropped — the controller would then start with
    // refCount=1 despite the caller already considering it released, leaking it (and its
    // background polling/event timers) forever. See feedback-volume-dial-animation-tuning memory.
    private pendingReleases: Map<string, number> = new Map();

    public async getController(ip: string): Promise<SonosDeviceController> {
        const entry = this.controllerEntries.get(ip);
        if (entry) {
            entry.refCount++;
            streamDeck.logger.debug(`[SonosDeviceManager] Reusing existing controller for IP: ${ip}. New refCount: ${entry.refCount}`);
            return entry.controller;
        }

        const pending = this.pendingInitializations.get(ip);
        if (pending) {
            streamDeck.logger.debug(`[SonosDeviceManager] Waiting for pending controller initialization for IP: ${ip}`);
            const controller = await pending;
            // After awaiting, the entry must be in controllerEntries.
            // We increment the refCount for THIS request.
            const newEntry = this.controllerEntries.get(ip);
            // It might happen, that the controller was released and destroyed in the meantime
            if (newEntry) {
                newEntry.refCount++;
                streamDeck.logger.debug(`[SonosDeviceManager] Reusing existing controller for IP: ${ip}. New refCount: ${newEntry.refCount}`);
            } else {
                // Controller was destroyed. Let's restart the process.
                return this.getController(ip);
            }
            return controller;
        }

        const promise = (async () => {
            try {
                streamDeck.logger.debug(`[SonosDeviceManager] Creating new controller for IP: ${ip}`);
                const controller = new SonosDeviceController(ip);
                await controller.initialize();

                // Account for any releases that arrived while we were still initializing.
                const queuedReleases = this.pendingReleases.get(ip) ?? 0;
                this.pendingReleases.delete(ip);
                const refCount = 1 - queuedReleases;
                if (refCount <= 0) {
                    streamDeck.logger.debug(`[SonosDeviceManager] Controller for IP: ${ip} was released before initialization finished — destroying immediately.`);
                    controller.destroy();
                    return controller;
                }

                this.controllerEntries.set(ip, { controller, refCount });
                return controller;
            } finally {
                this.pendingInitializations.delete(ip);
            }
        })();

        this.pendingInitializations.set(ip, promise);

        return promise;
    }

    public releaseController(ip: string): void {
        const entry = this.controllerEntries.get(ip);
        if (entry) {
            entry.refCount = Math.max(0, entry.refCount - 1);
            streamDeck.logger.debug(`[SonosDeviceManager] Released controller for IP: ${ip}. New refCount: ${entry.refCount}`);
            if (entry.refCount <= 0) {
                streamDeck.logger.debug(`[SonosDeviceManager] Destroying controller for IP: ${ip} as refCount is zero.`);
                entry.controller.destroy();
                this.controllerEntries.delete(ip);
            }
            return;
        }

        if (this.pendingInitializations.has(ip)) {
            this.pendingReleases.set(ip, (this.pendingReleases.get(ip) ?? 0) + 1);
            streamDeck.logger.debug(`[SonosDeviceManager] Queued release for IP: ${ip} — initialization still in flight.`);
            return;
        }

        streamDeck.logger.warn(`[SonosDeviceManager] Attempted to release a controller for an unknown IP: ${ip}`);
    }
}

export const sonosDeviceManager = new SonosDeviceManager();
