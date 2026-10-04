import streamDeck, {
    action,
    KeyDownEvent,
    KeyUpEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent
} from "@elgato/streamdeck";
import { DEFAULT_SEEK_STEP, SeekStepper, positionNow, type Player } from "@rocklobster42195/streamdeck-kit";
import { socPlayers } from "../bus/soc-players";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { discoveryPromise } from "../sonos/sonos-discovery";
import { TrackInfo } from "../sonos/SonosTypes";
import { generatePlaybackIcon, generateSeekIcon, generateUnreachableKeyIcon, INACTIVE_ICON_COLOR, OFF_ICON_COLOR } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { ControllerLease } from "./ControllerLease";
import { keyColorOf, onKeyColors, type KeyColorSettings } from "./key-color";

type SonosPlaybackSettings = KeyColorSettings & {
    deviceIp?: string;
    command?: 'next' | 'previous' | 'shuffle' | 'repeat';
    /** Seek mode (Next/Previous held): seconds per tap (default 10; the PI stores it as text). */
    seekStep?: number | string;
};

type Shown = { action: any; settings: SonosPlaybackSettings; device: string };

/** How long Next/Previous must be held to switch to seek mode. */
const LONG_PRESS_MS = 500;

@action({ UUID: "de.boriskemper.sonos-controller.playback-control-key" })
export class PlaybackControlKey extends SingletonAction<SonosPlaybackSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private initializedHash: Map<string, string> = new Map();
    private isRadioByContext: Map<string, boolean> = new Map();
    private playModeByContext: Map<string, string> = new Map();
    private shown = new Map<string, Shown>();
    private seekers = new Map<string, SeekStepper>();
    private holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private tickers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Keys whose current press already switched seek mode on or off (their release does nothing more). */
    private heldIntoSeek = new Set<string>();
    /** The image each key shows, so a redraw with the same look sends nothing. */
    private lastImage = new Map<string, string>();

    private setImage(action: any, image: string): void {
        if (this.lastImage.get(action.id) === image) return;
        this.lastImage.set(action.id, image);
        action.setImage(image).catch(() => {});
    }

    constructor() {
        super();
        // A cover or row colour changed: every key draws again in its colour
        onKeyColors(() => {
            for (const context of this.shown.keys()) this.redraw(context);
        });
    }

    private colorOf(context: string): string {
        const s = this.shown.get(context);
        return s ? keyColorOf(s.settings, this.lease.get(context), s.device) : '#CCCCCC';
    }

    private redraw(context: string): void {
        const s = this.shown.get(context);
        if (!s || !this.lease.get(context)) return;
        if (this.seekers.get(context)?.active) return this.drawSeek(context);
        this.updateIcon(s.action, s.settings.command, this.playModeByContext.get(context) ?? '', this.isRadioByContext.get(context) ?? false, this.colorOf(context));
    }

    private updateIcon(action: any, command: SonosPlaybackSettings['command'], playMode = '', isRadio = false, color = '#CCCCCC'): void {
        if (!action || !command) return;

        const skipColor = isRadio ? INACTIVE_ICON_COLOR : color;
        const set = (img: string) => this.setImage(action, img);

        switch (command) {
            case 'next':
                set(generatePlaybackIcon('next', false, skipColor));
                break;
            case 'previous':
                set(generatePlaybackIcon('previous', false, skipColor));
                break;
            case 'shuffle':
                set(generatePlaybackIcon('shuffle',
                    isRadio ? false : playMode.includes('SHUFFLE'),
                    color,
                    isRadio ? INACTIVE_ICON_COLOR : OFF_ICON_COLOR
                ));
                break;
            case 'repeat':
                if (isRadio) {
                    set(generatePlaybackIcon('repeat', false, color, INACTIVE_ICON_COLOR));
                } else if (playMode.includes('REPEAT_ONE')) {
                    // REPEAT_ONE or SHUFFLE_REPEAT_ONE
                    set(generatePlaybackIcon('repeat', 'one', color));
                } else if (playMode === 'REPEAT_ALL' || playMode === 'SHUFFLE' || playMode === 'SHUFFLE_REPEAT_ALL') {
                    // SHUFFLE in the Sonos API means shuffle + repeat-all (confusingly named).
                    set(generatePlaybackIcon('repeat', 'all', color));
                } else {
                    // NORMAL or SHUFFLE_NOREPEAT
                    set(generatePlaybackIcon('repeat', false, color));
                }
                break;
        }
    }

    private setupRetry = new SetupRetryScheduler();

    private async onInstanceUpdate(ev: WillAppearEvent<SonosPlaybackSettings> | DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        const { action, payload } = ev;
        const context = action.id;
        this.setupRetry.cancel(context);
        const { deviceIp, command } = payload.settings;
        this.shown.set(context, { action, settings: payload.settings, device: action.device.id });
        if (command !== 'next' && command !== 'previous') this.seekers.get(context)?.exit();

        // Same speaker and command: only the look may have changed (e.g. the colour)
        const currentHash = `${deviceIp}-${command}`;
        if (this.initializedHash.get(context) === currentHash) return this.redraw(context);

        await discoveryPromise;

        // Always release before reacquiring, even when deviceIp is unchanged — acquire() below
        // unconditionally increments refCount, so releasing only on an IP change leaked one
        // refCount per settings change (onDidReceiveSettings wipes initializedHash above, so the
        // early-return dedup never actually prevents this path from running). Must also run when
        // the config was CLEARED (early return below) — otherwise the old controller's callbacks
        // kept repainting this key with the stale command, refcount held forever.
        this.lease.release(context);

        if (!deviceIp || !command) {
            await action.setTitle("Config...");
            return;
        }

        try {
            const controller = await this.lease.acquire(context, deviceIp, (controller) => {
                controller.registerReachabilityCallback(context, (reachable) => {
                    if (reachable) {
                        this.initializedHash.delete(context);
                        void this.onInstanceUpdate(ev);
                    } else {
                        this.lastImage.delete(context);
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });

                // Matches the original isReachable-gated ordering below: the remaining callbacks
                // are only registered when the device is already known reachable at registration.
                if (controller.isReachable) {
                    controller.registerPlayModeCallback(context, (playMode) => {
                        this.playModeByContext.set(context, playMode);
                        this.redraw(context);
                    });
                    controller.registerTrackInfoCallback(context, (trackInfo: TrackInfo) => {
                        const isRadio = trackInfo.isRadio ?? false;
                        const wasRadio = this.isRadioByContext.get(context);
                        this.isRadioByContext.set(context, isRadio);
                        // Re-render whenever radio status changes — affects all command types.
                        if (isRadio !== wasRadio || command === 'next' || command === 'previous') this.redraw(context);
                    });
                }

                return [
                    () => controller.unregisterPlayModeCallback(context),
                    () => controller.unregisterTrackInfoCallback(context),
                    () => controller.unregisterReachabilityCallback(context),
                ];
            });

            // Bails out if the device is ALREADY unreachable at registration time, before any of
            // the callback registrations/renders below get a chance to overwrite the placeholder
            // just set above. Same fix as MultiControlKey's identical bug (2026-07-18).
            if (!controller.isReachable) return;

            const [currentMode] = await Promise.all([controller.getPlayMode()]);
            this.playModeByContext.set(context, currentMode);
            this.redraw(context);
            await action.setTitle("");

            this.initializedHash.set(context, currentHash);
            streamDeck.logger.debug(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Setup error:`, e);
            this.lastImage.delete(context);
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosPlaybackSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        // Speaker or command changed: set up again; only the colour or step: just draw again
        const s = this.shown.get(ev.action.id)?.settings;
        if (!s || s.deviceIp !== ev.payload.settings.deviceIp || s.command !== ev.payload.settings.command) this.initializedHash.delete(ev.action.id);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        this.lease.release(context);
        this.initializedHash.delete(context);
        this.isRadioByContext.delete(context);
        this.playModeByContext.delete(context);
        this.shown.delete(context);
        this.lastImage.delete(context);
        clearTimeout(this.holdTimers.get(context));
        this.holdTimers.delete(context);
        clearTimeout(this.tickers.get(context));
        this.tickers.delete(context);
        this.heldIntoSeek.delete(context);
        this.seekers.get(context)?.dispose();
        this.seekers.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.lease.get(context);
        const { command } = ev.payload.settings;

        if (!controller || !command) {
            ev.action.showAlert();
            return;
        }

        // Next/Previous act on release: a long press switches seek mode on (or off) instead
        if (command === 'next' || command === 'previous') {
            this.heldIntoSeek.delete(context);
            clearTimeout(this.holdTimers.get(context));
            this.holdTimers.set(context, setTimeout(() => {
                this.holdTimers.delete(context);
                this.heldIntoSeek.add(context);
                const seeker = this.seekerFor(context);
                if (seeker.active) seeker.exit();
                else if (!seeker.enter()) void ev.action.showAlert();
            }, LONG_PRESS_MS));
            return;
        }

        try {
            switch (command) {
                case 'shuffle':  await controller.toggleShuffle(); break;
                case 'repeat':   await controller.toggleRepeat(); break;
            }
        } catch {
            ev.action.showAlert();
        }
    }

    override async onKeyUp(ev: KeyUpEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        const { command, seekStep } = ev.payload.settings;
        if (command !== 'next' && command !== 'previous') return;
        const timer = this.holdTimers.get(context);
        clearTimeout(timer);
        this.holdTimers.delete(context);
        // The long press already switched seek mode on or off (or the press began before setup)
        if (this.heldIntoSeek.delete(context) || !timer) return;
        const seeker = this.seekers.get(context);
        if (seeker?.active) {
            // The PI stores the step as text ("10")
            const n = Number(seekStep);
            const step = n > 0 ? n : DEFAULT_SEEK_STEP;
            seeker.tap(command === 'next' ? step : -step);
            return;
        }
        const controller = this.lease.get(context);
        if (!controller) return void ev.action.showAlert();
        try {
            if (command === 'next') await controller.next();
            else await controller.previous();
        } catch {
            ev.action.showAlert();
        }
    }

    // ---- seek mode (grill 2026-10-04) ----

    /** The key's speaker group as a player on the deck (position, duration). */
    private playerOf(context: string): Player | undefined {
        const controller = this.lease.get(context);
        if (!controller) return undefined;
        const coordinator = controller.transportDevice;
        return socPlayers.resolve(`device:${coordinator.Uuid || coordinator.Host}`);
    }

    private seekerFor(context: string): SeekStepper {
        let seeker = this.seekers.get(context);
        if (seeker) return seeker;
        seeker = new SeekStepper({
            position: () => {
                const p = this.playerOf(context);
                return p ? positionNow(p) : undefined;
            },
            duration: () => this.playerOf(context)?.duration,
            seek: (target) => {
                const p = this.playerOf(context);
                if (p) socPlayers.send(p, 'seek', target).catch(() => void this.shown.get(context)?.action.showAlert());
            },
            onChange: () => this.redraw(context),
        });
        this.seekers.set(context, seeker);
        return seeker;
    }

    /** Seek mode: ⏩/⏪ in the key colour, the waiting jump ("+0:30") or where the track is ("1:23"). */
    private drawSeek(context: string): void {
        const s = this.shown.get(context);
        const seeker = this.seekers.get(context);
        if (!s || !seeker) return;
        const offset = seeker.offset;
        const p = this.playerOf(context);
        const text = offset ? `${offset > 0 ? '+' : '−'}${clock(Math.abs(offset))}` : clock((p && positionNow(p)) ?? 0);
        this.setImage(s.action, generateSeekIcon(s.settings.command === 'previous' ? 'back' : 'forward', this.colorOf(context), text));
        // While nothing waits, the shown position moves on with the track
        clearTimeout(this.tickers.get(context));
        if (!offset) this.tickers.set(context, setTimeout(() => this.redraw(context), 1000));
    }
}

/** Seconds as "1:23" (or "1:02:03"). */
function clock(seconds: number): string {
    const t = Math.max(0, Math.round(seconds));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
