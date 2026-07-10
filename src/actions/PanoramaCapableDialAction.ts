import { type JsonValue } from "@elgato/utils";
import {
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import {
    panoramaContextGroupKey,
    registerInPanorama,
    unregisterFromPanorama,
    isPanoramaEffectActive,
    setContextEffectId,
    setContextEffectSettings,
    registerPanoramaRenderCallback,
    unregisterPanoramaRenderCallback,
} from "../effects/PanoramaOrchestrator";
import { backfillEffectDefaults } from "../effects/backfillEffectDefaults";

// Shared lifecycle for any dial action that can participate in the panorama effects system
// (Volume/Track/Group Volume dial today; any future dial — e.g. a planned Queue Dial — extends
// this instead of re-copying the same ~150 lines a 4th time). Deliberately NOT extended by
// SonosDialParticles ("Panorama Effects" dial) — that action OWNS group orchestration (creates/
// destroys effect instances, runs the shared tick, registers the group-sync/settings-change
// handlers) and has no device concept or "opt in/out of effect mode" lifecycle at all, so its
// shape doesn't fit this base class.
export type PanoramaCapableSettings = {
    // 'none' | any registered effect id (e.g. 'particles', 'boing-ball') | an action-specific
    // extra non-effect mode (e.g. Track Dial's 'eq' — see isEffectMode()).
    visualizerMode?: string;
    [key: string]: JsonValue;
};

export abstract class PanoramaCapableDialAction<T extends PanoramaCapableSettings> extends SingletonAction<T> {
    protected contextColumns: Map<string, number> = new Map();
    protected settingsMap: Map<string, T> = new Map();
    private animTimers: Map<string, NodeJS.Timeout> = new Map();

    protected abstract onInstanceUpdate(ev: WillAppearEvent<T> | DidReceiveSettingsEvent<T>): Promise<void>;
    protected abstract cleanupInstance(context: string): void;
    protected abstract renderDial(context: string): Promise<void>;

    override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
        const col = 'coordinates' in ev.payload ? (ev.payload.coordinates as { column: number }).column : 0;
        this.contextColumns.set(ev.action.id, col);
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
        this.cleanupInstance(ev.action.id);
        this.leavePanorama(ev.action.id);
        this.contextColumns.delete(ev.action.id);
    }

    // 'none' is never a registered effect — everything else is looked up in effectRegistry.
    // Override to exclude additional action-specific non-effect modes (e.g. Track Dial's 'eq').
    protected isEffectMode(mode?: string): boolean {
        return !!mode && mode !== 'none';
    }

    // Extra condition (beyond "in effect mode") to keep the shared anim timer alive — e.g. Track
    // Dial also needs it while actively PLAYING (for its progress bar/cover animation), not just
    // in effect mode. Default: no extra condition.
    protected shouldKeepAnimating(_context: string): boolean {
        return false;
    }

    // While in an active effect group (grouped or solo singleton), the shared tick's render
    // callback drives rendering instead — this timer just keeps the interval alive and skips its
    // own render call, avoiding two independent, potentially out-of-phase render sources for the
    // same effect (that caused a brief "mirrored"/desynced look every few bounces).
    protected startAnimTimer(context: string): void {
        if (this.animTimers.has(context)) return;
        const timer = setInterval(() => {
            const settings = this.settingsMap.get(context);
            const inEffectMode = this.isEffectMode(settings?.visualizerMode);
            const inPanorama = isPanoramaEffectActive(inEffectMode ? panoramaContextGroupKey.get(context) : undefined);
            if (!inPanorama && !inEffectMode && !this.shouldKeepAnimating(context)) {
                this.stopAnimTimer(context);
                return;
            }
            if (!inPanorama) void this.renderDial(context);
        }, 50);
        this.animTimers.set(context, timer);
    }

    protected stopAnimTimer(context: string): void {
        const timer = this.animTimers.get(context);
        if (timer) { clearInterval(timer); this.animTimers.delete(context); }
    }

    // Leaves the shared panorama system — only call when actually exiting effect mode or when
    // the tile itself is being removed. Must NOT be called unconditionally on every settings
    // update: doing so wipes the shared group key before syncGroups gets a chance to detect a
    // live effect switch (e.g. Boing Ball -> Boing Globe), which then just re-initializes the
    // stale effect instance instead of switching to the newly selected one.
    protected leavePanorama(context: string): void {
        unregisterFromPanorama(context);
        unregisterPanoramaRenderCallback(context);
        this.stopAnimTimer(context);
    }

    // Registers this context as an effect participant in the shared panorama system (an adjacent
    // dial wanting the SAME effect merges into one shared instance; otherwise this renders its
    // own effect solo — a "group" of one is exactly how solo rendering works, see
    // PanoramaOrchestrator), or leaves it if not currently in effect mode.
    protected syncPanoramaParticipation(context: string, settings: T): void {
        if (this.isEffectMode(settings.visualizerMode)) {
            registerInPanorama(context, this.contextColumns.get(context) ?? 0);
            setContextEffectId(context, settings.visualizerMode!);
            setContextEffectSettings(context, settings);
            registerPanoramaRenderCallback(context, () => this.renderDial(context));
            this.startAnimTimer(context);
        } else {
            this.leavePanorama(context);
        }
    }

    // Fills in any missing simple-field defaults (e.g. Volume Dial's `showText`) AND any missing
    // effect-schema defaults (via backfillEffectDefaults) into `settings`, persisting via a
    // single setSettings call if anything changed. Returns the (possibly updated) settings to use
    // for the rest of this render pass.
    protected applyBackfill(ev: WillAppearEvent<T> | DidReceiveSettingsEvent<T>, settings: T, extraDefaults: Partial<T> = {}): T {
        let result = settings;
        let saveNeeded = false;
        for (const key of Object.keys(extraDefaults) as (keyof T)[]) {
            if (result[key] === undefined) {
                result = { ...result, [key]: extraDefaults[key] };
                saveNeeded = true;
            }
        }
        if (this.isEffectMode(result.visualizerMode)) {
            const backfill = backfillEffectDefaults(result, result.visualizerMode);
            if (backfill.changed) {
                result = backfill.settings as T;
                saveNeeded = true;
            }
        }
        if (saveNeeded) void ev.action.setSettings(result);
        return result;
    }
}
