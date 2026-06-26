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

/**
 * Einstellungen für {@link SonosPlaybackControlAction}.
 */
type SonosPlaybackSettings = {
    deviceIp?: string;
    command?: 'next' | 'previous' | 'shuffle' | 'repeat';
};

/**
 * Eine Action, die mehrere Wiedergabesteuerungen für ein Sonos-Gerät bereitstellt.
 */
@action({ UUID: "de.boriskemper.sonos-controller.sonos-playback-control" })
export class SonosPlaybackControlAction extends SingletonAction<SonosPlaybackSettings> {
    // Speichert die Controller-Instanzen pro Taste
    private controllers: Map<string, SonosDeviceController> = new Map();
    
    // Speichert den Status der Initialisierung, um Endlosschleifen und Log-Spam zu vermeiden
    private initializedHash: Map<string, string> = new Map();

    /**
     * Aktualisiert das Icon basierend auf dem gewählten Befehl und dem Play-Modus.
     */
    private updateIcon(action: any, command: SonosPlaybackSettings['command'], playMode: string = "") {
        if (!action || !command) return;
        streamDeck.logger.debug(`[playback-control] updateIcon action=${action.id} command=${command} playMode=${playMode}`);

        let icon = "";
        const baseIconPath = "imgs/actions/sonos-playback-control/";

        switch (command) {
            case 'next':
                icon = `${baseIconPath}skip-next-cccccc.png`;
                break;
            case 'previous':
                icon = `${baseIconPath}skip-previous-cccccc.png`;
                break;
            case 'shuffle':
                icon = playMode.includes('SHUFFLE') 
                    ? `${baseIconPath}shuffle-cccccc.png` 
                    : `${baseIconPath}shuffle-off-cccccc.png`;
                break;
            case 'repeat':
                if (playMode.includes('REPEAT_ONE')) {
                    icon = `${baseIconPath}repeat-once-cccccc.png`;
                } else if (playMode.includes('REPEAT_ALL')) {
                    icon = `${baseIconPath}repeat-cccccc.png`;
                } else {
                    icon = `${baseIconPath}repeat-off-cccccc.png`;
                }
                break;
            default:
                return;
        }
        
        if (icon) {
            streamDeck.logger.debug(`[playback-control] set icon=${icon}`);
            action.setImage(icon);
        }
    }

    /**
     * Zentrale Methode zur Initialisierung und Aktualisierung der Action.
     */
    private async onInstanceUpdate(ev: WillAppearEvent<SonosPlaybackSettings> | DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const { deviceIp, command } = payload.settings;

        // 1. Prüfen, ob dieses Setup bereits aktiv ist (Schleifenschutz)
        const currentHash = `${deviceIp}-${command}`;
        if (this.initializedHash.get(context) === currentHash) {
            return; 
        }

        // 2. Warten auf Discovery
        await discoveryPromise;

        // 3. Prüfung auf unvollständige Konfiguration
        if (!deviceIp || !command) {
            streamDeck.logger.debug(`[${context}] Konfiguration fehlt: IP=${deviceIp}, Cmd=${command}`);
            await action.setTitle("Config...");
            return;
        }

        try {
            // --- Alten Controller aufräumen, falls die IP wechselt ---
            const oldController = this.controllers.get(context);
            if (oldController && oldController.deviceIp !== deviceIp) {
                oldController.unregisterPlayModeCallback(context);
                sonosDeviceManager.releaseController(oldController.deviceIp);
            }

            // --- Neuen Controller binden ---
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);
            
            // Callback für Live-Updates (Icon-Sync bei Shuffle/Repeat)
            controller.unregisterPlayModeCallback(context);
            controller.registerPlayModeCallback(context, (playMode) => {
                this.updateIcon(action, command, playMode);
            });

            // Initialen PlayMode holen und Icon setzen
            const currentMode = await controller.getPlayMode();
            this.updateIcon(action, command, currentMode);
            await action.setTitle("");
            
            // Status als "fertig initialisiert" markieren
            this.initializedHash.set(context, currentHash);
            streamDeck.logger.info(`[${context}] Initialisiert: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Fehler beim Setup:`, e);
            await action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosPlaybackSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }
    
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        // Cache löschen, damit eine manuelle Änderung im PI sofort verarbeitet wird
        this.initializedHash.delete(ev.action.id);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterPlayModeCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
        this.initializedHash.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosPlaybackSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        const { command } = ev.payload.settings;

        if (!controller || !command) {
            ev.action.showAlert();
            return;
        }

        try {
            switch (command) {
                case 'next': await controller.next(); break;
                case 'previous': await controller.previous(); break;
                case 'shuffle': await controller.toggleShuffle(); break;
                case 'repeat': await controller.toggleRepeat(); break;
            }
        } catch (e) {
            ev.action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosPlaybackSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;

                // Erzeuge Liste der Speaker
                const deviceItems = sonosManager.Devices.map((device: SonosDevice) => ({
                    label: device.Name,
                    value: device.Host
                }));

                // Füge die Leerzeile / Placeholder GANZ OBEN ein
                const itemsWithPlaceholder = [
                    { label: "-- Choose device --", value: "" },
                    ...deviceItems
                ];

                await streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: itemsWithPlaceholder
                });
            }
        }
    }
}