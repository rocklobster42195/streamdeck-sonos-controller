// Pure step planning for volume fades (fade-out before switching favorites, fade-in after).
// Kept free of any Sonos/streamdeck imports so it can be unit-tested.

export type FadeStep = {
    /** Absolute volume to set at this step. */
    volume: number;
    /** Delay before applying this step, in ms. */
    delayMs: number;
};

// Sonos speakers handle roughly a handful of SOAP calls per second per device; stepping faster
// than this just queues requests without sounding smoother.
const MIN_STEP_INTERVAL_MS = 150;

/**
 * Plans an even volume ramp from `from` to `to` over `durationMs`.
 * The last step always lands exactly on `to`. Returns [] when there is nothing to do.
 */
export function computeFadeSteps(from: number, to: number, durationMs: number): FadeStep[] {
    from = clampVolume(from);
    to = clampVolume(to);
    if (from === to || durationMs <= 0) return [];

    const distance = Math.abs(to - from);
    const stepCount = Math.max(1, Math.min(distance, Math.floor(durationMs / MIN_STEP_INTERVAL_MS)));
    const delayMs = durationMs / stepCount;

    const steps: FadeStep[] = [];
    let previous = from;
    for (let i = 1; i <= stepCount; i++) {
        const volume = Math.round(from + ((to - from) * i) / stepCount);
        if (volume === previous) continue; // skip no-op SetVolume calls on coarse ramps
        steps.push({ volume, delayMs });
        previous = volume;
    }
    return steps;
}

function clampVolume(v: number): number {
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
}
