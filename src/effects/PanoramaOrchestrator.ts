// Action-agnostic panorama group orchestration, shared by every dial action that can
// participate in a panorama (Panorama Effects, Track Dial, Volume Dial, Group Volume Dial).
//
// Responsibility split: this module only tracks column adjacency and computes which
// contexts belong to which group (connected components over column adjacency). It knows
// nothing about SONOS devices, colors, or which effect is running — that stays owned by
// whichever action registers the group-sync handler (today: SonosDialParticles).
//
// Registration happens in that action's constructor, which always runs at plugin startup
// (see src/plugin.ts) regardless of whether a Panorama Effects tile is currently placed on
// the Stream Deck. This means Track/Volume/Group Volume dials can register into a panorama
// and get a group key even when no Panorama Effects tile is mounted at all.

import streamDeck from "@elgato/streamdeck";
import type { EffectInstance } from "./types";

export const DISPLAY_W = 200;
export const DISPLAY_H = 100;

export type GroupSyncHandler = (newGrouping: Map<string, string[]>) => Promise<void> | void;

// Third-party effects are reviewed at PR time (see CONTRIBUTING_EFFECTS.md), not sandboxed at
// load time — a bug that throws from tickPanorama/renderSlice/onRotate/onPress would otherwise
// take down the whole plugin process (every action, every dial), not just the panorama running
// that effect. Every call into effect-supplied code goes through this so one broken effect just
// skips a frame/interaction instead of crashing everything.
export function safeEffectCall<T>(fn: () => T, fallback: T, what: string): T {
    try {
        return fn();
    } catch (e) {
        streamDeck.logger.error(`Panorama effect threw in ${what} — ignoring this call: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        return fallback;
    }
}

class PanoramaOrchestratorImpl {
    readonly panoramaColumns = new Map<string, number>();
    readonly panoramaContextGroupKey = new Map<string, string>();
    // Which effect each context wants to run. Populated by whichever action owns that context
    // (all 4 dial actions) whenever it registers into the panorama — computeAllGroups() only
    // merges adjacent columns that want the SAME effect; a column running a different effect (or
    // no effect at all) starts its own group instead, which is what makes a single unmatched
    // dial render its chosen effect solo rather than joining its neighbor.
    readonly contextEffectId = new Map<string, string>();
    // The currently-running EffectInstance per group key. Owned/populated by whichever action
    // registers the group-sync handler (SonosDialParticles) — it creates, ticks, and destroys
    // these — but stored here so OTHER actions in the same panorama (Track/Volume/Group Volume
    // dial) can render their own slice of it without any direct coupling to that action.
    readonly groupEffects = new Map<string, EffectInstance<any>>();
    // Per-context "please redraw yourself now" callbacks. Every action registers its own here
    // when it registers into the panorama. The shared group tick (owned by SonosDialParticles)
    // calls all of a group's callbacks immediately after ticking the effect, so every display in
    // the group renders from the exact same tick instead of each polling on its own independent
    // setInterval — independent timers drift out of phase with each other over time, which
    // showed up as an intermittent visual glitch at display boundaries (e.g. Boing Ball's spin
    // looking briefly "mirrored"/jumped every few bounces).
    readonly renderCallbacks = new Map<string, () => void>();

    private handler: GroupSyncHandler | null = null;
    private syncTimer: NodeJS.Timeout | null = null;

    /** Exactly one handler is expected — the action that owns effect/group lifecycle. */
    setGroupSyncHandler(handler: GroupSyncHandler): void {
        this.handler = handler;
    }

    registerInPanorama(context: string, column: number): void {
        this.panoramaColumns.set(context, column);
        this.requestSync();
    }

    unregisterFromPanorama(context: string): void {
        this.panoramaContextGroupKey.delete(context);
        this.panoramaColumns.delete(context);
        this.contextEffectId.delete(context);
        this.renderCallbacks.delete(context);
        this.requestSync();
    }

    setContextEffectId(context: string, effectId: string): void {
        if (this.contextEffectId.get(context) === effectId) return;
        this.contextEffectId.set(context, effectId);
        this.requestSync();
    }

    registerRenderCallback(context: string, cb: () => void): void {
        this.renderCallbacks.set(context, cb);
    }

    unregisterRenderCallback(context: string): void {
        this.renderCallbacks.delete(context);
    }

    notifyGroupRender(ctxs: Iterable<string>): void {
        for (const ctx of ctxs) this.renderCallbacks.get(ctx)?.();
    }

    getPanoramaSliceOffset(context: string): number {
        const col = this.panoramaColumns.get(context) ?? 0;
        const key = this.panoramaContextGroupKey.get(context);
        if (!key) return 0;
        const minCol = Math.min(...this.colsFromKey(key));
        return (col - minCol) * DISPLAY_W;
    }

    panoramaKey(cols: number[]): string {
        return 'panorama-cols-' + [...cols].sort((a, b) => a - b).join(',');
    }

    colsFromKey(key: string): number[] {
        return key.replace('panorama-cols-', '').split(',').map(Number);
    }

    /**
     * Connected components over column adjacency (adjacent columns differ by exactly 1) AND
     * matching chosen effect — two adjacent dials only join the same group if they want the same
     * effect. A dial next to a differently-configured (or unconfigured) neighbor still forms its
     * own single-member group, which is exactly what makes it render its effect solo.
     * Returns Map<groupKey, contexts[]>.
     */
    computeAllGroups(): Map<string, string[]> {
        const sorted = [...this.panoramaColumns.entries()].sort(([, a], [, b]) => a - b);
        const result = new Map<string, string[]>();
        let i = 0;
        while (i < sorted.length) {
            const cols = [sorted[i][1]];
            const ctxs = [sorted[i][0]];
            const effectId = this.contextEffectId.get(sorted[i][0]);
            while (
                i + 1 < sorted.length &&
                sorted[i + 1][1] === sorted[i][1] + 1 &&
                this.contextEffectId.get(sorted[i + 1][0]) === effectId
            ) {
                i++;
                cols.push(sorted[i][1]);
                ctxs.push(sorted[i][0]);
            }
            result.set(this.panoramaKey(cols), ctxs);
            i++;
        }
        return result;
    }

    /** Debounce rapid appear/disappear events so one sync handles all of them at once. */
    requestSync(): void {
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            void this.handler?.(this.computeAllGroups());
        }, 60);
    }
}

export const panoramaOrchestrator = new PanoramaOrchestratorImpl();

// Back-compat named exports so existing action files (Track/Volume/Group Volume dial) keep
// working with the same import shape they already use.
export const panoramaColumns = panoramaOrchestrator.panoramaColumns;
export const panoramaContextGroupKey = panoramaOrchestrator.panoramaContextGroupKey;

export function registerInPanorama(context: string, column: number): void {
    panoramaOrchestrator.registerInPanorama(context, column);
}

export function unregisterFromPanorama(context: string): void {
    panoramaOrchestrator.unregisterFromPanorama(context);
}

export function setContextEffectId(context: string, effectId: string): void {
    panoramaOrchestrator.setContextEffectId(context, effectId);
}

export function registerPanoramaRenderCallback(context: string, cb: () => void): void {
    panoramaOrchestrator.registerRenderCallback(context, cb);
}

export function unregisterPanoramaRenderCallback(context: string): void {
    panoramaOrchestrator.unregisterRenderCallback(context);
}

export function getPanoramaSliceOffset(context: string): number {
    return panoramaOrchestrator.getPanoramaSliceOffset(context);
}

export const groupEffects = panoramaOrchestrator.groupEffects;

/** Renders this group's active effect's slice for a display at `offsetX`, or '' if there is no
 *  active effect for this key (e.g. panorama not yet formed). */
export function renderPanoramaEffectSlice(key: string | undefined, offsetX: number): string {
    if (!key) return '';
    const effect = groupEffects.get(key);
    if (!effect) return '';
    return safeEffectCall(() => effect.renderSlice(offsetX, DISPLAY_W, DISPLAY_H), '', 'renderSlice');
}

export function isPanoramaEffectActive(key: string | undefined): boolean {
    return !!key && groupEffects.has(key);
}
