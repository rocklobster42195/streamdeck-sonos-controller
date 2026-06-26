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
    showTrackTitle?: boolean; // Neu: Laufschrift für den aktuellen Titel
    fontColor?: string;
    fontSize?: number;        // Neu: Schriftgröße für die Laufschrift
};

@action({ UUID: "de.boriskemper.sonos-controller.sonos-toggle-play" })
export class SonosTogglePlay extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private currentSettings: Map<string, SonosSettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();

    /**
     * Verarbeitet Track-Info-Änderungen (für Cover von Radiostationen und Alben)
     */
    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const newCover = trackInfo.albumArtDataUri || undefined;
        const oldCover = this.currentCover.get(context) || undefined;
        
        streamDeck.logger.debug(`[${context}] onTrackInfoChanged: ${trackInfo.Title}, cover: ${newCover ? "yes" : "none"}`);
        
        // Nur wenn die Cover sich geändert hat
        if (newCover !== oldCover) {
            this.currentCover.set(context, newCover);
            // Trigger handleTransportStateChange um View zu aktualizieren
            const controller = this.controllers.get(context);
            if (controller) {
                controller.getTransportState().then(state => {
                    this.handleTransportStateChange(context, state, newCover);
                });
            }
        }
    }

    /**
     * Aktualisiert die Anzeige (Bild & Animation) basierend auf dem Transport-Status.
     */
    private async handleTransportStateChange(context: string, transportState: string, newCover?: string): Promise<void> {
        const action = streamDeck.actions.getActionById(context);
        if (!action) return;

        const settings = this.currentSettings.get(context);
        const controller = this.controllers.get(context);
        if (!controller || !settings) return;

        streamDeck.logger.info(`[${context}] State: ${transportState}, newCover: ${newCover ? "yes" : "no"}`);

        if (transportState === "PLAYING") {
            // Nutze newCover wenn vorhanden, ansonsten verwende currentCover, ansonsten versuche zu holen
            let cover = newCover;
            if (!cover) {
                const storedCover = this.currentCover.get(context);
                if (storedCover) {
                    cover = storedCover;
                    streamDeck.logger.debug(`[${context}] Using stored cover`);
                } else {
                    cover = await controller.getCurrentTrackCover();
                    streamDeck.logger.debug(`[${context}] Loaded fresh cover: ${cover ? "yes" : "no"}`);
                }
            }
            
            // Speichere die aktuelle Cover für zukünftige Verwendung (nur wenn vorhanden)
            if (cover) this.currentCover.set(context, cover);
            
            streamDeck.logger.debug(`[${context}] showTrackTitle: ${settings.showTrackTitle}, showCoverArt: ${settings.showCoverArt}, cover available: ${cover ? "yes" : "no"}`);

            if (settings.showTrackTitle) {
                // Titel abrufen
                const track = await controller.getCurrentTrack();
                const title = track?.Title
                    ? `${track.Title}${track.Artist ? ` [${track.Artist}]` : ""}`
                    : "";

                const animOptions = {
                    text: title,
                    // Nur Cover wenn verfügbar UND showCoverArt = true, ansonsten kein Background
                    backgroundImage: (settings.showCoverArt && cover) ? cover : undefined,
                    fontColor: settings.fontColor || "#cccccc",
                    fontSize: settings.fontSize ? settings.fontSize : 13,
                    pauseDuration: 120,
                    interval: 80
                };

                if (titleAnimator.isRunning(context)) {
                    titleAnimator.update(context, { text: title, backgroundImage: animOptions.backgroundImage });
                } else {
                    // Animation starten (Animator übernimmt das setImage)
                    titleAnimator.start(action, animOptions);
                }
            } else {
                // Statische Anzeige ohne Animation
                titleAnimator.stop(context);
                if (settings.showCoverArt && cover) {
                    streamDeck.logger.info(`[${context}] Setting static cover image`);
                    await action.setImage(cover);
                } else {
                    streamDeck.logger.info(`[${context}] Setting fallback play button`);
                    await action.setImage("imgs/actions/sonos-toggle-play/play-circle-cccccc.png");
                }
            }
        } else {
            // Musik pausiert oder gestoppt -> Animation aus
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

        // Cleanup alter Controller
        if (this.controllers.has(context)) {
            const oldController = this.controllers.get(context)!;
            oldController.unregisterTransportStateCallback(context);
            oldController.unregisterCoverCallback(context);
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

            // Callback für Status-Änderungen (Play/Pause)
            controller.registerTransportStateCallback(context, (state) => {
                this.handleTransportStateChange(context, state);
            });

            // Callback für Cover-Änderungen (nächster Song)
            controller.registerCoverCallback(context, async (cover) => {
                const state = await controller.getTransportState();
                await this.handleTransportStateChange(context, state, cover);
            });

            // Callback für Track-Info-Änderungen (wichtig für Radiostationen!)
            controller.registerTrackInfoCallback(context, (trackInfo) => {
                this.onTrackInfoChanged(context, trackInfo);
            });

            // Titel-Anzeige (Gerätename)
            if (settings.showDeviceName) {
                const zoneAttributes = await controller.getZoneAttributes();
                await action.setTitle(zoneAttributes.CurrentZoneName);
            } else {
                await action.setTitle("");
            }

            // Initialen Status setzen
            const state = await controller.getTransportState();
            
            // Wenn PLAYING, Track-Info + Cover gleich laden BEVOR wir rendern
            if (state === "PLAYING") {
                if (!this.currentCover.has(context)) {
                    const track = await controller.getCurrentTrack();
                    if (track) {
                        streamDeck.logger.info(`[${context}] Initial track loaded: ${track.Title}`);
                    }
                    const initialCover = await controller.getCurrentTrackCover();
                    if (initialCover) {
                        this.currentCover.set(context, initialCover);
                        streamDeck.logger.info(`[${context}] Initial cover loaded`);
                    } else {
                        streamDeck.logger.warn(`[${context}] Initial cover NOT available`);
                    }
                }
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
            controller.unregisterCoverCallback(context);
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