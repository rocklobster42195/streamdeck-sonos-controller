// Volume fade steps (fade-out before switching favorites, fade-in after) from the kit, at the step
// rate Sonos handles: speakers take roughly a handful of SOAP calls per second per device;
// stepping faster just queues requests without sounding smoother.
import { computeFadeSteps as kitFadeSteps, type FadeStep } from "@rocklobster42195/streamdeck-kit";

export type { FadeStep };

export const SONOS_MIN_STEP_INTERVAL_MS = 150;

export function computeFadeSteps(from: number, to: number, durationMs: number): FadeStep[] {
    return kitFadeSteps(from, to, durationMs, SONOS_MIN_STEP_INTERVAL_MS);
}
