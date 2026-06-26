import streamDeck from "@elgato/streamdeck";
import { SonosDeviceController } from "./SonosDeviceController";

type ControllerEntry = {
    controller: SonosDeviceController;
    refCount: number;
};

class SonosDeviceManager {
    private controllerEntries: Map<string, ControllerEntry> = new Map();
    private pendingInitializations: Map<string, Promise<SonosDeviceController>> = new Map();

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
                // The first request gets a refCount of 1.
                this.controllerEntries.set(ip, { controller, refCount: 1 });
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
        } else {
            streamDeck.logger.warn(`[SonosDeviceManager] Attempted to release a controller for an unknown IP: ${ip}`);
        }
    }
}

export const sonosDeviceManager = new SonosDeviceManager();
