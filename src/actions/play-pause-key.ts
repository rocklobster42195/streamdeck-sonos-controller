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
import { generateTransportIcon, renderBatteryBadge, renderProgressBar, wrapImageWithBadge, generateUnreachableKeyIcon } from "../utils/icons";
import { getDominantColor, ensureVisibleColor } from "../utils/color-extract";
import { parseRelTime } from "../sonos/rel-time";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";

/**
 * Settings for {@link PlayPauseKey}.
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
    // Thin bar at the bottom of the key showing track position, filled in the cover's dominant
    // color — mirrors Track Dial's progress bar. Off by default (an extra always-off UPnP poll
    // per key otherwise); see fetchAndStorePosition/startProgressTimer.
    showProgress?: boolean;
};

@action({ UUID: "de.boriskemper.sonos-controller.play-pause-key" })
export class PlayPauseKey extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private currentSettings: Map<string, SonosSettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();
    private batteryStatuses: Map<string, SonosBatteryStatus | undefined> = new Map();
    private lastTransportState: Map<string, string> = new Map();
    // Progress-bar-only state (all no-ops when a key's showProgress setting is off).
    private trackPositions: Map<string, { pos: number; dur: number; time: number }> = new Map();
    private dominantColors: Map<string, string> = new Map();
    private lastColorUri: Map<string, string> = new Map();
    private progressTimers: Map<string, NodeJS.Timeout> = new Map();

    private onTrackInfoChanged(context: string, trackInfo: TrackInfo): void {
        const newCover = trackInfo.albumArtDataUri || undefined;
        const oldCover = this.currentCover.get(context) || undefined;

        // Skip when the same real cover is already showing.
        if (newCover && newCover === oldCover) return;
        // Skip when no new art arrives but a cached cover is already visible.
        if (!newCover && oldCover) return;

        if (newCover) {
            this.currentCover.set(context, newCover);
            this.updateDominantColor(context, newCover);
        }
        const controller = this.controllers.get(context);
        if (controller) {
            // Must not float unhandled — a rejection here (device briefly unreachable) would
            // otherwise crash the whole plugin process, same class of bug as un-awaited
            // next()/previous() calls (see SonosDeviceController's basic-controls comment).
            controller.getTransportState()
                .then(state => this.handleTransportStateChange(context, state, newCover))
                .catch(e => streamDeck.logger.warn(`[${context}] transport state refresh failed`, e));
        }
    }

    // --- Progress bar helpers (all independent of showTrackTitle) ---

    private updateDominantColor(context: string, cover: string): void {
        if (this.lastColorUri.get(context) === cover) return;
        this.lastColorUri.set(context, cover);
        getDominantColor(cover).then(color => {
            this.dominantColors.set(context, ensureVisibleColor(color));
        }).catch(() => {});
    }

    private async fetchAndStorePosition(context: string, controller: SonosDeviceController): Promise<void> {
        try {
            const pos = await controller.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
            this.trackPositions.set(context, {
                pos: parseRelTime(pos.RelTime),
                dur: parseRelTime(pos.TrackDuration),
                time: Date.now(),
            });
        } catch { /* keep last known position */ }
    }

    // undefined = no usable duration yet (radio, or position not fetched); 0-1 otherwise.
    private computeProgress(context: string): number | undefined {
        const p = this.trackPositions.get(context);
        if (!p || p.dur <= 5) return undefined;
        const elapsed = this.lastTransportState.get(context) === 'PLAYING' ? (Date.now() - p.time) / 1000 : 0;
        return Math.max(0, Math.min(1, (p.pos + elapsed) / p.dur));
    }

    // Only runs while PLAYING (the key shows a static icon, no cover/bar at all, whenever it
    // isn't) — ticks every 1s, cheap enough for a progress bar (no need for TitleAnimator's
    // 50-80ms marquee cadence). Pushes into TitleAnimator when the marquee is active (its own
    // loop then picks the new value up on its next tick); repaints directly otherwise, since a
    // cover-only key has no other redraw loop to piggyback on.
    private refreshProgressTick(context: string): void {
        const settings = this.currentSettings.get(context);
        if (!settings?.showProgress || this.lastTransportState.get(context) !== 'PLAYING') {
            this.stopProgressTimer(context);
            return;
        }
        // undefined (radio / no known duration) means "don't draw the bar this tick" — passed
        // straight through rather than coerced to 0, see AnimationOptions.progress's doc comment.
        const progress = this.computeProgress(context);
        const color = this.dominantColors.get(context) ?? '#CCCCCC';

        if (titleAnimator.isRunning(context)) {
            titleAnimator.setProgress(context, progress, color);
            return;
        }

        const action = streamDeck.actions.getActionById(context);
        const cover = this.currentCover.get(context);
        if (!action || settings.showCoverArt === false || !cover) return;
        const badge72 = renderBatteryBadge(settings.batteryDisplayMode ?? 'warning', this.batteryStatuses.get(context), 56, 3, 12);
        void action.setImage(wrapImageWithBadge(cover, badge72 + renderProgressBar(progress, color)));
    }

    private startProgressTimer(context: string): void {
        if (this.progressTimers.has(context)) return;
        this.progressTimers.set(context, setInterval(() => this.refreshProgressTick(context), 1000));
    }

    private stopProgressTimer(context: string): void {
        const t = this.progressTimers.get(context);
        if (t) { clearInterval(t); this.progressTimers.delete(context); }
    }

    private onBatteryChanged(context: string, battery: SonosBatteryStatus | undefined): void {
        this.batteryStatuses.set(context, battery);
        void this.handleTransportStateChange(context, this.lastTransportState.get(context) ?? 'STOPPED');
    }

    // Never throws/rejects: every caller invokes this fire-and-forget (event callbacks, `void`),
    // so a rejection escaping here would be an unhandled rejection that kills the plugin process.
    private async handleTransportStateChange(context: string, transportState: string, newCover?: string): Promise<void> {
        try {
            await this.handleTransportStateChangeUnsafe(context, transportState, newCover);
        } catch (e) {
            streamDeck.logger.warn(`[${context}] handleTransportStateChange failed`, e);
        }
    }

    private async handleTransportStateChangeUnsafe(context: string, transportState: string, newCover?: string): Promise<void> {
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
            if (cover) {
                this.currentCover.set(context, cover);
                this.updateDominantColor(context, cover);
            }

            if (settings.showProgress) {
                await this.fetchAndStorePosition(context, controller);
                this.startProgressTimer(context);
            } else {
                this.stopProgressTimer(context);
            }
            // undefined both when the feature is off AND when the current source has no known
            // duration (radio) — either way, no bar to draw. See AnimationOptions.progress.
            const progress = settings.showProgress ? this.computeProgress(context) : undefined;
            const progressColor = this.dominantColors.get(context) ?? '#CCCCCC';

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
                    batteryBadge: badge72,
                    progress,
                    progressColor,
                };

                if (titleAnimator.isRunning(context)) {
                    titleAnimator.update(context, { text: title, backgroundImage: animOptions.backgroundImage });
                    titleAnimator.setBatteryBadge(context, badge72);
                    titleAnimator.setProgress(context, progress, progressColor);
                } else {
                    titleAnimator.start(action, animOptions);
                }
            } else {
                titleAnimator.stop(context);
                if (settings.showCoverArt !== false && cover) {
                    const progressBar = progress !== undefined ? renderProgressBar(progress, progressColor) : '';
                    await action.setImage(wrapImageWithBadge(cover, badge72 + progressBar));
                } else {
                    await action.setImage(generateTransportIcon('play', undefined, badge24));
                }
            }
        } else {
            titleAnimator.stop(context);
            this.stopProgressTimer(context);

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
        this.stopProgressTimer(context);
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
            // Release by the controller's OWN IP (not the current settings' deviceIp) so the
            // release always matches the acquisition, like every other action does.
            sonosDeviceManager.releaseController(controller.deviceIp);
        }
        this.stopProgressTimer(context);
        this.controllers.delete(context);
        this.currentSettings.delete(context);
        this.currentCover.delete(context);
        this.batteryStatuses.delete(context);
        this.lastTransportState.delete(context);
        this.trackPositions.delete(context);
        this.dominantColors.delete(context);
        this.lastColorUri.delete(context);
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
                        items: [{ label: piT('-- Choose device --'), value: '' }, ...items]
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