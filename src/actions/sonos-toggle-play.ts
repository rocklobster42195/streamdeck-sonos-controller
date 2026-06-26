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
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-toggle-play" })
export class SonosTogglePlay extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private currentSettings: Map<string, SonosSettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();

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

    private async handleTransportStateChange(context: string, transportState: string, newCover?: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        if (!action) return;

        const settings = this.currentSettings.get(context);
        const controller = this.controllers.get(context);
        if (!controller || !settings) return;

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
                    backgroundImage: (settings.showCoverArt && cover) ? cover : undefined,
                    fontColor: settings.fontColor || "#cccccc",
                    fontSize: settings.fontSize ? settings.fontSize : 13,
                    pauseDuration: 120,
                    interval: 80
                };

                if (titleAnimator.isRunning(context)) {
                    titleAnimator.update(context, { text: title, backgroundImage: animOptions.backgroundImage });
                } else {
                    titleAnimator.start(action, animOptions);
                }
            } else {
                titleAnimator.stop(context);
                if (settings.showCoverArt && cover) {
                    await action.setImage(cover);
                } else {
                    await action.setImage("imgs/actions/sonos-toggle-play/play-circle-cccccc.png");
                }
            }
        } else {
            titleAnimator.stop(context);

            switch (transportState) {
                case "TRANSITIONING":
                    await action.setImage("imgs/actions/sonos-toggle-play/timer-sand-cccccc.png");
                    break;
                default: // PAUSED, STOPPED
                    await action.setImage("imgs/actions/sonos-toggle-play/play-circle-cccccc.png");
                    break;
            }
        }
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const action = ev.action;
        const settings = ev.payload.settings;

        if (this.controllers.has(context)) {
            const oldController = this.controllers.get(context)!;
            oldController.unregisterTransportStateCallback(context);
            oldController.unregisterTrackInfoCallback(context);
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

            // Transport state changes (play/pause/stop)
            controller.registerTransportStateCallback(context, (state) => {
                this.handleTransportStateChange(context, state);
            });

            // Track info changes — this is the only cover update path
            controller.registerTrackInfoCallback(context, (trackInfo) => {
                this.onTrackInfoChanged(context, trackInfo);
            });

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
            await action.setTitle("Error");
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
        titleAnimator.stop(context);

        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterTransportStateCallback(context);
            controller.unregisterTrackInfoCallback(context);
            if (ev.payload.settings.deviceIp) {
                sonosDeviceManager.releaseController(ev.payload.settings.deviceIp);
            }
        }
        this.controllers.delete(context);
        this.currentSettings.delete(context);
        this.currentCover.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            await controller.togglePlayPause();
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
            }
        }
    }
}