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
import { discoveryPromise } from "../sonos/sonos-discovery";
import { TrackInfo } from "../sonos/SonosTypes";
import { generatePlaybackIcon, generateUnreachableKeyIcon, INACTIVE_ICON_COLOR, OFF_ICON_COLOR } from "../utils/icons";
import { SetupRetryScheduler } from "../utils/SetupRetryScheduler";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendOptions } from "./pi-options";
import { ControllerLease } from "./ControllerLease";

type SonosPlaybackSettings = {
    deviceIp?: string;
    command?: 'next' | 'previous' | 'shuffle' | 'repeat';
};

@action({ UUID: "de.boriskemper.sonos-controller.playback-control-key" })
export class PlaybackControlKey extends SingletonAction<SonosPlaybackSettings> {
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );
    private initializedHash: Map<string, string> = new Map();
    private isRadioByContext: Map<string, boolean> = new Map();
    private playModeByContext: Map<string, string> = new Map();

    private updateIcon(action: any, command: SonosPlaybackSettings['command'], playMode = '', isRadio = false): void {
        if (!action || !command) return;

        const skipColor = isRadio ? INACTIVE_ICON_COLOR : '#CCCCCC';
        const set = (img: string) => action.setImage(img).catch(() => {});

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
                    '#CCCCCC',
                    isRadio ? INACTIVE_ICON_COLOR : OFF_ICON_COLOR
                ));
                break;
            case 'repeat':
                if (isRadio) {
                    set(generatePlaybackIcon('repeat', false, '#CCCCCC', INACTIVE_ICON_COLOR));
                } else if (playMode.includes('REPEAT_ONE')) {
                    // REPEAT_ONE or SHUFFLE_REPEAT_ONE
                    set(generatePlaybackIcon('repeat', 'one'));
                } else if (playMode === 'REPEAT_ALL' || playMode === 'SHUFFLE' || playMode === 'SHUFFLE_REPEAT_ALL') {
                    // SHUFFLE in the Sonos API means shuffle + repeat-all (confusingly named).
                    set(generatePlaybackIcon('repeat', 'all'));
                } else {
                    // NORMAL or SHUFFLE_NOREPEAT
                    set(generatePlaybackIcon('repeat', false));
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

        const currentHash = `${deviceIp}-${command}`;
        if (this.initializedHash.get(context) === currentHash) return;

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
                        void action.setImage(generateUnreachableKeyIcon());
                        void action.setTitle("");
                    }
                });

                // Matches the original isReachable-gated ordering below: the remaining callbacks
                // are only registered when the device is already known reachable at registration.
                if (controller.isReachable) {
                    controller.registerPlayModeCallback(context, (playMode) => {
                        this.playModeByContext.set(context, playMode);
                        this.updateIcon(action, command, playMode, this.isRadioByContext.get(context) ?? false);
                    });
                    controller.registerTrackInfoCallback(context, (trackInfo: TrackInfo) => {
                        const isRadio = trackInfo.isRadio ?? false;
                        const wasRadio = this.isRadioByContext.get(context);
                        this.isRadioByContext.set(context, isRadio);
                        // Re-render whenever radio status changes — affects all command types.
                        if (isRadio !== wasRadio || command === 'next' || command === 'previous') {
                            this.updateIcon(action, command, this.playModeByContext.get(context) ?? '', isRadio);
                        }
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
            this.updateIcon(action, command, currentMode, this.isRadioByContext.get(context) ?? false);
            await action.setTitle("");

            this.initializedHash.set(context, currentHash);
            streamDeck.logger.debug(`[${context}] Initialized: IP=${deviceIp}, Cmd=${command}`);

        } catch (e) {
            streamDeck.logger.error(`[${context}] Setup error:`, e);
            await action.setImage(generateUnreachableKeyIcon());
            await action.setTitle("");
            this.setupRetry.schedule(context, () => void this.onInstanceUpdate(ev));
        }
    }

    override async onWillAppear(ev: WillAppearEvent<SonosPlaybackSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosPlaybackSettings>): Promise<void> {
        this.initializedHash.delete(ev.action.id);
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosPlaybackSettings>): Promise<void> {
        const context = ev.action.id;
        this.setupRetry.cancel(context);
        this.lease.release(context);
        this.initializedHash.delete(context);
        this.isRadioByContext.delete(context);
        this.playModeByContext.delete(context);
    }

    override async onKeyDown(ev: KeyDownEvent<SonosPlaybackSettings>): Promise<void> {
        const controller = this.lease.get(ev.action.id);
        const { command } = ev.payload.settings;

        if (!controller || !command) {
            ev.action.showAlert();
            return;
        }

        try {
            switch (command) {
                case 'next':     await controller.next(); break;
                case 'previous': await controller.previous(); break;
                case 'shuffle':  await controller.toggleShuffle(); break;
                case 'repeat':   await controller.toggleRepeat(); break;
            }
        } catch {
            ev.action.showAlert();
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosPlaybackSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        switch (ev.payload.event) {
            case 'get-devices': await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp); break;
            case 'get-command-options':
                sendOptions('get-command-options', [
                    { label: piT('-- Select Command --'), value: '' },
                    { label: piT('Next Track'), value: 'next' },
                    { label: piT('Previous Track'), value: 'previous' },
                    { label: piT('Toggle Shuffle'), value: 'shuffle' },
                    { label: piT('Toggle Repeat'), value: 'repeat' },
                ]);
                break;
        }
    }
}
