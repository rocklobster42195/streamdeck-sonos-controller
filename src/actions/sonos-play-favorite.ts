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
import { sonosManager, discoveryPromise, sonosFavoritesCache } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { titleAnimator } from "../utils/TitleAnimator";

type Favorite = {
    Title: string;
    AlbumArtUri: string;
    [key: string]: any;
};

type SonosFavoriteSettings = {
    deviceIp?: string;
    favorite?: string; 
    showTitle?: boolean;
};

@action({ UUID: "de.boriskemper.sonos-controller.play-favorite" })
export class SonosPlayFavorite extends SingletonAction<SonosFavoriteSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();

    private async onInstanceUpdate(ev: WillAppearEvent<SonosFavoriteSettings> | DidReceiveSettingsEvent<SonosFavoriteSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        const { deviceIp, favorite, showTitle } = payload.settings;

        if (this.controllers.has(context)) {
            sonosDeviceManager.releaseController(this.controllers.get(context)!.deviceIp);
            this.controllers.delete(context);
        }

        await discoveryPromise;

        if (!deviceIp || !favorite) {
            titleAnimator.stop(context);
            await action.setTitle("Config...");
            return;
        }

        try {
            const controller = await sonosDeviceManager.getController(deviceIp);
            this.controllers.set(context, controller);
            
            const favObject = JSON.parse(favorite) as Favorite;
            const coverArt = sonosFavoritesCache.getCoverArt(favObject.AlbumArtUri);

            await action.setTitle("");

            if (showTitle) {
                titleAnimator.start(action, {
                    text: favObject.Title,
                    backgroundImage: coverArt,
                    fontColor: "white",
                    speed: 0.8,
                    pauseDuration: 80
                });
            } else {
                titleAnimator.stop(context);
                await action.setImage(coverArt || undefined);
            }

        } catch (e) {
            streamDeck.logger.error(`Error in onInstanceUpdate [${context}]:`, e);
            await action.setTitle("Error");
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosFavoriteSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }
    
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosFavoriteSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosFavoriteSettings>): Promise<void> {
        const context = ev.action.id;
        titleAnimator.stop(context);

        const controller = this.controllers.get(context);
        if (controller) {
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.controllers.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosFavoriteSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.controllers.get(action.id);
        const { favorite } = payload.settings;

        if (!controller || !favorite) {
            action.showAlert();
            return;
        }

        try {
            const favObject = JSON.parse(favorite);
            await controller.playFavorite(favObject);
            action.showOk();
        } catch (e) {
            streamDeck.logger.error("Error playing favorite:", e);
            action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosFavoriteSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            const payload = ev.payload as any;
            switch (payload.event) {
                case 'get-devices': {
                    await discoveryPromise;
                    const deviceItems = sonosManager.Devices.map((device: SonosDevice) => ({
                        label: device.Name,
                        value: device.Host
                    }));
                    streamDeck.ui.sendToPropertyInspector({
                        event: 'get-devices',
                        items: [{ label: "-- Choose device --", value: "" }, ...deviceItems]
                    });
                    break;
                }
                case 'get-favorites': {
                    if (!sonosFavoritesCache.areFavoritesLoaded()) {
                        streamDeck.ui.sendToPropertyInspector({
                            event: 'get-favorites',
                            items: [{ label: "Loading...", value: "" }]
                        });
                        return;
                    }
                    const favorites = sonosFavoritesCache.getFavorites() || [];
                    const favoriteItems = favorites.map((fav: Favorite) => ({
                        label: fav.Title,
                        value: JSON.stringify(fav)
                    }));
                    streamDeck.ui.sendToPropertyInspector({
                        event: 'get-favorites',
                        items: [{ label: "-- Select Favorite --", value: "" }, ...favoriteItems]
                    });
                    break;
                }
            }
        }
    }
}