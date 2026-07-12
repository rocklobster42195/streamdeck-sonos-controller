import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { titleAnimator } from "../utils/TitleAnimator";
import { TrackInfo } from "../sonos/SonosTypes";
import { SonosBatteryStatus, deviceHasBattery } from "../sonos/SonosBattery";
import { generateTransportIcon, renderBatteryBadge, wrapImageWithBadge, generateUnreachableKeyIcon } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";

/**
 * Settings for {@link SonosTogglePlay}.
 */
type SonosSettings = {
    deviceIp?: string;
    showDeviceName?: boolean;
    showCoverArt?: boolean;
    showTrackTitle?: boolean;
    fontColor?: string;
    fontSize?: number;
    // 'off' | 'warning' (icon only while battery is low) | 'full' (always shows level/charging).
    // Only ever rendered when the device actually reports battery data (Roam/Move) — see
    // SonosBattery.ts. Defaults to 'warning' when unset (see handleTransportStateChange).
    batteryDisplayMode?: 'off' | 'warning' | 'full';
    // Internal, PI-only field: whether the current deviceIp reports battery data — refreshed on
    // every settings sync (see onInstanceUpdate) and written back via setSettings() so the PI can
    // react to it through the settings-sync channel (a hidden <sdpi-checkbox setting="hasBattery">
    // toggles the battery-mode dropdown's visibility — see battery-capability.js).
    hasBattery?: boolean;
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-toggle-play" })
export class SonosTogglePlay extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private currentSettings: Map<string, SonosSettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();
    private batteryStatuses: Map<string, SonosBatteryStatus | undefined> = new Map();
    private lastTransportState: Map<string, string> = new Map();

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const newCover = trackInfo.albumArtDataUri || undefined;
        const oldCover = this.currentCover.get(context) || undefined;

        // Skip when the same real cover is already showing.
        if (newCover && newCover === oldCover) return;
        // Skip when no new art arrives but a cached cover is already visible.
        if (!newCover && oldCover) return;

        if (newCover) this.currentCover.set(context, newCover);
        const controller = this.controllers.get(context);
        if (controller) {
            controller.getTransportState().then(state => {
                this.handleTransportStateChange(context, state, newCover);
            });
        }
    }

    private onBatteryChanged(context: string, battery: SonosBatteryStatus | undefined): void {
        this.batteryStatuses.set(context, battery);
        void this.handleTransportStateChange(context, this.lastTransportState.get(context) ?? 'STOPPED');
    }

    private async handleTransportStateChange(context: string, transportState: string, newCover?: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        if (!action) return;

        const settings = this.currentSettings.get(context);
        const controller = this.controllers.get(context);
        if (!controller || !settings) return;

        this.lastTransportState.set(context, transportState);
        const batteryMode = settings.batteryDisplayMode ?? 'warning';
        const battery = this.batteryStatuses.get(context);
        // 24x24 viewBox (static icons) vs. 72x72 (cover art / scrolling title) need differently
        // scaled badge geometry, but the same underlying mode/battery decision.
        const badge24 = renderBatteryBadge(batteryMode, battery, 16, 1, 6);
        const badge72 = renderBatteryBadge(batteryMode, battery, 56, 3, 12);

        if (transportState === "PLAYING") {
            let cover = newCover || this.currentCover.get(context) || undefined;
            if (!cover) {
                // Cover cache empty — happens when the plugin starts/restarts during a radio news
                // segment with no art. Try once to fetch from the controller (which derives the
                // station logo from the stream URI, stable even during news).
                try { cover = await controller.getCurrentTrackCover() || undefined; } catch {}
            }
            if (cover) this.currentCover.set(context, cover);
            
            streamDeck.logger.debug(`[${context}] showTrackTitle: ${settings.showTrackTitle}, showCoverArt: ${settings.showCoverArt}, cover available: ${cover ? "yes" : "no"}`);

            if (settings.showTrackTitle) {
                const track = await controller.getCurrentTrack();
                const title = track?.Title
                    ? `${track.Title}${track.Artist ? ` [${track.Artist}]` : ""}`
                    : "";

                const animOptions = {
                    text: title,
                    backgroundImage: (settings.showCoverArt !== false && cover) ? cover : undefined,
                    fontColor: settings.fontColor || "#cccccc",
                    fontSize: settings.fontSize ? settings.fontSize : 13,
                    pauseDuration: 120,
                    interval: 80,
                    batteryBadge: badge72
                };

                if (titleAnimator.isRunning(context)) {
                    titleAnimator.update(context, { text: title, backgroundImage: animOptions.backgroundImage });
                    titleAnimator.setBatteryBadge(context, badge72);
                } else {
                    titleAnimator.start(action, animOptions);
                }
            } else {
                titleAnimator.stop(context);
                if (settings.showCoverArt !== false && cover) {
                    await action.setImage(wrapImageWithBadge(cover, badge72));
                } else {
                    await action.setImage(generateTransportIcon('play', undefined, badge24));
                }
            }
        } else {
            titleAnimator.stop(context);

            switch (transportState) {
                case "TRANSITIONING":
                    await action.setImage(generateTransportIcon('loading', undefined, badge24));
                    break;
                default: // PAUSED, STOPPED
                    await action.setImage(generateTransportIcon('play', undefined, badge24));
                    break;
            }
        }
    }

    private setupRetry = new SetupRetryScheduler();

    async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const action = ev.action;
        let settings = ev.payload.settings;
        this.setupRetry.cancel(context);

        if (this.controllers.has(context)) {
            const oldController = this.controllers.get(context)!;
            oldController.unregisterTransportStateCallback(context);
            oldController.unregisterTrackInfoCallback(context);
            oldController.unregisterBatteryCallback(context);
            oldController.unregisterReachabilityCallback(context);
            // Must release here — getController() below unconditionally increments refCount,
            // so skipping this leaked one refCount per re-init (every onWillAppear/settings
            // change), permanently orphaning the controller and its polling/event timers once
            // this instance eventually disappears (onWillDisappear only releases once).
            sonosDeviceManager.releaseController(oldController.deviceIp);
            this.controllers.delete(context);
        }
        this.currentCover.delete(context);

        if (!settings.deviceIp) {
            titleAnimator.stop(context);
            await action.setTitle("");
            action.showAlert();
            return;
        }

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            const hasBattery = await deviceHasBattery(settings.deviceIp);
            if (settings.hasBattery !== hasBattery) {
                settings = { ...settings, hasBattery };
                this.currentSettings.set(context, settings);
                await action.setSettings(settings);
            }

            // Mid-session reachability: speaker-off placeholder while the device is down (e.g. a
            // battery Roam powered off), full re-setup once it's back.
            controller.registerReachabilityCallback(context, (reachable) => {
                if (reachable) {
                    void this.onInstanceUpdate(ev);
                } else {
                    titleAnimator.stop(context);
                    void action.setImage(generateUnreachableKeyIcon());
                    void action.setTitle("");
                }
            });

            // Transport state changes (play/pause/stop)
            controller.registerTransportStateCallback(context, (state) => {
                this.handleTransportStateChange(context, state);
            });

            // Track info changes — this is the only cover update path
            controller.registerTrackInfoCallback(context, (trackInfo) => {
                this.onTrackInfoChanged(context, trackInfo);
            });

            if ((settings.batteryDisplayMode ?? 'warning') !== 'off') {
                controller.registerBatteryCallback(context, (b) => this.onBatteryChanged(context, b));
            }

            if (settings.showDeviceName) {
                const zoneAttributes = await controller.getZoneAttributes();
                await action.setTitle(zoneAttributes.CurrentZoneName);
            } else {
                await action.setTitle("");
            }

            const state = await controller.getTransportState();
            
            // Prime the cover cache before first render.
            // For radio stations this often returns undefined — trackInfoCallback fills it later.
            if (state === "PLAYING" && !this.currentCover.has(context)) {
                const initialCover = await controller.getCurrentTrackCover();
                if (initialCover) this.currentCover.set(context, initialCover);
            }
            
            await this.handleTransportStateChange(context, state);

        } catch (e) {
            streamDeck.logger.error(`Error updating instance ${context}`, e);
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            // Speaker may just be powered off (e.g. a battery Roam) — retry the whole setup
            // periodically so cover/title recover on their own once it's back online.
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        this.currentSettings.set(ev.action.id, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        this.currentSettings.set(context, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        titleAnimator.stop(context);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            controller.unregisterBatteryCallback(context);
            controller.unregisterReachabilityCallback(context);
            if (ev.payload.settings.deviceIp) {
                sonosDeviceManager.releaseController(ev.payload.settings.deviceIp);
            }
        }
        this.controllers.delete(context);
        this.currentSettings.delete(context);
        this.currentCover.delete(context);
        this.batteryStatuses.delete(context);
        this.lastTransportState.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (!controller) return;
        try {
            await controller.togglePlayPause();
        } catch (e) {
            // An uncaught rejection here crashes the whole plugin process (every device/action),
            // not just this key — must not propagate.
            streamDeck.logger.warn('togglePlayPause() failed', e);
            ev.action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            switch (ev.payload.event) {
                case 'get-devices': {
                    await discoveryPromise;
                    const items = sonosManager.Devices.map((device: SonosDevice) => ({
                        label: device.Name,
                        value: device.Host
                    }));
                    streamDeck.ui.sendToPropertyInspector({
                        event: 'get-devices',
                        items: items
                    });
                    break;
                }
                case 'get-battery-mode-options': {
                    streamDeck.ui.sendToPropertyInspector({
                        event: 'get-battery-mode-options',
                        items: [
                            { label: piT('Off'), value: 'off' },
                            { label: piT('Warning (low battery only)'), value: 'warning' },
                            { label: piT('Always'), value: 'full' },
                        ],
                    });
                    break;
                }
            }
        }
    }
}