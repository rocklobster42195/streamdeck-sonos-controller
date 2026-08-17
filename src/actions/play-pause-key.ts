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
import { titleAnimator } from "../utils/TitleAnimator";
import { TrackInfo } from "../sonos/SonosTypes";
import { SonosBatteryStatus, deviceHasBattery } from "../sonos/SonosBattery";
import { generateTransportIcon, renderBatteryBadge, renderProgressBar, wrapImageWithBadge, generateUnreachableKeyIcon } from "../utils/icons";
import { getDominantColor, ensureVisibleColor } from "../utils/color-extract";
import { parseRelTime } from "../sonos/rel-time";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { syncCapabilityFlag } from "./capability-flag";
import { sendDeviceList, sendBatteryModeOptions } from "./pi-options";
import { ControllerLease } from "./ControllerLease";

/**
 * Settings for {@link PlayPauseKey}.
 */
type PlayPauseKeySettings = {
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
export class PlayPauseKey extends SingletonAction<PlayPauseKeySettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private currentSettings: Map<string, PlayPauseKeySettings> = new Map();
    private currentCover: Map<string, string | undefined> = new Map();
    private batteryStatuses: Map<string, SonosBatteryStatus | undefined> = new Map();
    private lastTransportState: Map<string, string> = new Map();
    // Progress-bar-only state (all no-ops when a key's showProgress setting is off).
    private trackPositions: Map<string, { pos: number; dur: number; time: number }> = new Map();
    private dominantColors: Map<string, string> = new Map();
    private lastColorUri: Map<string, string> = new Map();
    private progressTimers: Map<string, NodeJS.Timeout> = new Map();
    // Guards against Stream Deck re-sending onWillAppear/onDidReceiveSettings for a tile that's
    // already correctly set up — confirmed on hardware (2026-07-18): Stream Deck can re-send
    // onWillAppear for tiles that are already visible, with no user action and no actual settings
    // change, repeatedly and for many tiles/devices near-simultaneously. Each full onInstanceUpdate
    // rebuild does real network work (release+reacquire the controller, fresh GetTransportState,
    // GENA re-subscribe), which compounds into noticeable lag. Deliberately only wraps
    // onWillAppear/onDidReceiveSettings (the actual Stream Deck entry points) — the reachability
    // callback's own "reachable:true" branch and setupRetry call onInstanceUpdate directly, so a
    // real recovery rebuild after the device comes back online is unaffected.
    private lastAppliedSettingsJson: Map<string, string> = new Map();
    // Tracks, per context, whether THIS context's own reachability callback last reported the
    // device unreachable and hasn't yet seen a recovery — deliberately NOT the same thing as
    // controller.isReachable (a device-global flag driven by the background poll loop's own ~8s
    // cadence, up to 2 consecutive failures old). Using that flag to gate onBatteryChanged's
    // repaint caused a regression on hardware (2026-07-18, mass restart across 9 devices): a
    // battery callback fires SYNCHRONOUSLY with the cached status the moment it's registered
    // during onInstanceUpdate's own initial setup — right after that same setup already proved
    // reachability via its own successful getZoneAttributes/getTransportState calls — but the
    // laggy poll-driven flag could still read stale-false from an earlier hiccup, silently
    // skipping the very first icon render and leaving the tile stuck on its default icon (title
    // already set correctly, icon never painted). This set is instead driven exactly by this
    // context's own registerReachabilityCallback below, so it can never be stale relative to it.
    private unreachableContexts: Set<string> = new Set();

    private skipRedundantUpdate(context: string, settings: PlayPauseKeySettings): boolean {
        const settingsJson = JSON.stringify(settings);
        if (this.lease.has(context) && this.lastAppliedSettingsJson.get(context) === settingsJson) {
            return true;
        }
        this.lastAppliedSettingsJson.set(context, settingsJson);
        return false;
    }

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
        const controller = this.lease.get(context);
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
        // The independent battery-poll loop has no network call of its own to naturally fail
        // while unreachable — without this check, a battery update arriving right after this
        // context's reachability callback showed the unreachable placeholder repainted straight
        // over it with the stale "PLAYING" cover. Confirmed on hardware (2026-07-18): powering off
        // a battery Roam left the Toggle key showing its last cover as if still playing, with only
        // the battery badge gone. Gated on unreachableContexts (this context's own last-known
        // state), not controller.isReachable — see that field's own doc comment for why the
        // device-global, poll-cadence-driven flag caused a regression here.
        if (this.unreachableContexts.has(context)) return;
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
        const controller = this.lease.get(context);
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

    async onInstanceUpdate(ev: WillAppearEvent<PlayPauseKeySettings> | DidReceiveSettingsEvent<PlayPauseKeySettings>): Promise<void> {
        const context = ev.action.id;
        const action = ev.action;
        let settings = ev.payload.settings;
        this.setupRetry.cancel(context);

        this.lease.release(context);
        this.stopProgressTimer(context);
        this.currentCover.delete(context);

        if (!settings.deviceIp) {
            titleAnimator.stop(context);
            await action.setTitle("");
            action.showAlert();
            return;
        }

        // Set before acquiring so a callback that fires synchronously during registration (e.g. a
        // reused controller's cached trackInfo) already has settings available — matches the
        // original ordering's guarantee that handleTransportStateChangeUnsafe's `if (!settings)
        // return;` guard never fires spuriously. syncCapabilityFlag below only ever changes the
        // unrelated `hasBattery` field, so setting this early is safe.
        this.currentSettings.set(context, settings);

        try {
            const controller = await this.lease.acquire(context, settings.deviceIp, (controller) => {
                // Mid-session reachability: speaker-off placeholder while the device is down (e.g. a
                // battery Roam powered off), full re-setup once it's back.
                controller.registerReachabilityCallback(context, (reachable) => {
                    if (reachable) {
                        this.unreachableContexts.delete(context);
                        void this.onInstanceUpdate(ev);
                    } else {
                        this.unreachableContexts.add(context);
                        titleAnimator.stop(context);
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });

                // Matches the original isReachable-gated ordering below: the remaining callbacks
                // are only registered when the device is already known reachable at registration.
                if (controller.isReachable) {
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
                }

                return [
                    () => controller.unregisterTransportStateCallback(context),
                    () => controller.unregisterTrackInfoCallback(context),
                    () => controller.unregisterBatteryCallback(context),
                    () => controller.unregisterReachabilityCallback(context),
                ];
            });

            // registerReachabilityCallback fires synchronously above if the device is ALREADY
            // unreachable at registration time — bail out here so nothing below (some of it not
            // network-dependent, e.g. a cached capability flag) unconditionally overwrites the
            // placeholder that was just set. Same fix as MultiControlKey's identical bug
            // (2026-07-18): the very first setup happened to be saved by deviceHasBattery/
            // getZoneAttributes/getTransportState failing outright on a cold-unreachable device,
            // but a LATER unreachable transition — reached via this same reachability callback's
            // own "reachable:true" branch re-running onInstanceUpdate — isn't guaranteed to hit a
            // failing network call before reaching the unconditional render further down.
            if (!controller.isReachable) return;

            // undefined means "couldn't determine right now" — leave the persisted hasBattery
            // flag as it was rather than writing a false negative (see deviceHasBattery's own
            // doc comment for the hardware case this fixes).
            const hasBatteryResult = await deviceHasBattery(settings.deviceIp);
            if (hasBatteryResult !== undefined) {
                settings = await syncCapabilityFlag(action, settings, 'hasBattery', hasBatteryResult);
            }
            this.currentSettings.set(context, settings);

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

    override async onWillAppear(ev: WillAppearEvent<PlayPauseKeySettings>): Promise<void> {
        if (this.skipRedundantUpdate(ev.action.id, ev.payload.settings)) return;
        this.currentSettings.set(ev.action.id, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PlayPauseKeySettings>): Promise<void> {
        const context = ev.action.id;
        if (this.skipRedundantUpdate(context, ev.payload.settings)) return;
        this.currentSettings.set(context, ev.payload.settings);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<PlayPauseKeySettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        titleAnimator.stop(context);

        this.lease.release(context);
        this.stopProgressTimer(context);
        this.currentSettings.delete(context);
        this.currentCover.delete(context);
        this.batteryStatuses.delete(context);
        this.lastTransportState.delete(context);
        this.trackPositions.delete(context);
        this.dominantColors.delete(context);
        this.lastColorUri.delete(context);
        this.lastAppliedSettingsJson.delete(context);
        this.unreachableContexts.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<PlayPauseKeySettings>): Promise<void> {
        const controller = this.lease.get(ev.action.id);
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

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PlayPauseKeySettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-devices': await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp); break;
            case 'get-battery-mode-options': sendBatteryModeOptions(); break;
        }
    }
}