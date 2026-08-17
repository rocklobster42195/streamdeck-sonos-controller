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
import { discoveryPromise, sonosFavoritesCache } from "../sonos/sonos-discovery";
import { ControllerLease } from "./ControllerLease";
import { titleAnimator } from "../utils/TitleAnimator";
import { generateUnreachableKeyIcon } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { SonosFavorite } from "../sonos/SonosTypes";
import { sendDeviceList, sendFadeOptions, sendOptions } from "./pi-options";

type SonosFavoriteSettings = {
    deviceIp?: string;
    favorite?: string;
    showTitle?: boolean;
    fadeDuration?: string; // seconds as string from the PI select, "0"/undefined = no fade
};

@action({ UUID: "de.boriskemper.sonos-controller.play-favorite-key" })
export class PlayFavoriteKey extends SingletonAction<SonosFavoriteSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    // Guards against Stream Deck re-sending onWillAppear/onDidReceiveSettings for a tile that's
    // already correctly set up — confirmed on hardware (2026-07-18): Stream Deck can re-send
    // onWillAppear for tiles that are already visible, with no user action and no actual settings
    // change, repeatedly and for many tiles/devices near-simultaneously. Each full onInstanceUpdate
    // rebuild does real network work (release+reacquire the controller, GENA re-subscribe), which
    // compounds into noticeable lag. Deliberately only wraps onWillAppear/onDidReceiveSettings (the
    // actual Stream Deck entry points) — the reachability callback's own "reachable:true" branch
    // and setupRetry call onInstanceUpdate directly, so a real recovery rebuild after the device
    // comes back online is unaffected.
    private lastAppliedSettingsJson: Map<string, string> = new Map();

    private skipRedundantUpdate(context: string, settings: SonosFavoriteSettings): boolean {
        const settingsJson = JSON.stringify(settings);
        if (this.lease.has(context) && this.lastAppliedSettingsJson.get(context) === settingsJson) {
            return true;
        }
        this.lastAppliedSettingsJson.set(context, settingsJson);
        return false;
    }

    private setupRetry = new SetupRetryScheduler();

    private async onInstanceUpdate(ev: WillAppearEvent<SonosFavoriteSettings> | DidReceiveSettingsEvent<SonosFavoriteSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        this.setupRetry.cancel(context);
        const { deviceIp, favorite, showTitle } = payload.settings;

        this.lease.release(context);

        await discoveryPromise;

        if (!deviceIp || !favorite) {
            titleAnimator.stop(context);
            await action.setTitle("Config...");
            return;
        }

        try {
            const controller = await this.lease.acquire(context, deviceIp, (controller) => {
                controller.registerReachabilityCallback(context, (reachable) => {
                    if (reachable) {
                        void this.onInstanceUpdate(ev);
                    } else {
                        titleAnimator.stop(context);
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });
                return [() => controller.unregisterReachabilityCallback(context)];
            });

            // Bails out if the device is ALREADY unreachable at registration time — everything
            // below is a purely local render (no network call to naturally fail on first), which
            // would otherwise immediately overwrite the placeholder just set above. Same fix as
            // MultiControlKey's identical bug (2026-07-18).
            if (!controller.isReachable) return;

            const favObject = JSON.parse(favorite) as SonosFavorite;
            const coverArt = favObject.AlbumArtUri ? sonosFavoritesCache.getCoverArt(favObject.AlbumArtUri) : undefined;

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
            titleAnimator.stop(context);
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosFavoriteSettings>): Promise<void> {
        if (this.skipRedundantUpdate(ev.action.id, ev.payload.settings)) return;
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosFavoriteSettings>): Promise<void> {
        if (this.skipRedundantUpdate(ev.action.id, ev.payload.settings)) return;
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosFavoriteSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        titleAnimator.stop(context);

        this.lease.release(context);
        this.lastAppliedSettingsJson.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosFavoriteSettings>): Promise<void> {
        const { action, payload } = ev;
        const controller = this.lease.get(action.id);
        const { favorite, fadeDuration } = payload.settings;

        if (!controller || !favorite) {
            action.showAlert();
            return;
        }

        const fadeMs = (Number(fadeDuration) || 0) * 1000;
        try {
            const favObject = JSON.parse(favorite) as SonosFavorite;
            if (fadeMs > 0) {
                // A multi-second fade shouldn't leave the key without feedback — confirm the
                // press immediately; the audible fade itself signals the switch is underway.
                action.showOk();
                await controller.playFavoriteWithFade(favObject, fadeMs);
            } else {
                await controller.playFavorite(favObject);
                action.showOk();
            }
        } catch (e) {
            streamDeck.logger.error("Error playing favorite:", e);
            action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosFavoriteSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch ((ev.payload as any).event) {
            case 'get-devices': await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp); break;
            case 'get-fade-options': sendFadeOptions(); break;
            case 'get-favorites': {
                if (!sonosFavoritesCache.areFavoritesLoaded()) {
                    sendOptions('get-favorites', [{ label: "Loading...", value: "" }]);
                    return;
                }
                const favorites = sonosFavoritesCache.getFavorites() || [];
                const favoriteItems = favorites.map((fav) => ({
                    label: fav.Title,
                    value: JSON.stringify(fav)
                }));
                sendOptions('get-favorites', [{ label: "-- Select Favorite --", value: "" }, ...favoriteItems]);
                break;
            }
        }
    }
}