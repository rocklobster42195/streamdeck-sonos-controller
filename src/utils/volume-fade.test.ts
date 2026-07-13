import { describe, expect, it } from "vitest";
import { computeFadeSteps } from "./volume-fade";

describe("computeFadeSteps", () => {
    it("returns no steps when volumes are equal or duration is zero", () => {
        expect(computeFadeSteps(30, 30, 3000)).toEqual([]);
        expect(computeFadeSteps(30, 0, 0)).toEqual([]);
        expect(computeFadeSteps(30, 0, -100)).toEqual([]);
    });

    it("always ends exactly on the target volume", () => {
        for (const [from, to, ms] of [[42, 0, 3000], [0, 42, 1500], [17, 3, 800], [99, 100, 5000]] as const) {
            const steps = computeFadeSteps(from, to, ms);
            expect(steps.length).toBeGreaterThan(0);
            expect(steps[steps.length - 1].volume).toBe(to);
        }
    });

    it("spreads delays evenly across the requested duration", () => {
        const steps = computeFadeSteps(50, 0, 3000);
        const total = steps.reduce((sum, s) => sum + s.delayMs, 0);
        expect(total).toBeCloseTo(3000, 0);
        expect(new Set(steps.map((s) => s.delayMs)).size).toBe(1);
    });

    it("never steps faster than the Sonos-safe interval", () => {
        const steps = computeFadeSteps(100, 0, 2000);
        for (const s of steps) expect(s.delayMs).toBeGreaterThanOrEqual(150);
    });

    it("produces strictly monotonic volumes without duplicates", () => {
        const steps = computeFadeSteps(5, 0, 10000); // coarse ramp: fewer volumes than time slots
        const volumes = steps.map((s) => s.volume);
        expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
        expect(new Set(volumes).size).toBe(volumes.length);
        expect(volumes[volumes.length - 1]).toBe(0);
    });

    it("clamps out-of-range inputs", () => {
        const steps = computeFadeSteps(150, -20, 1000);
        expect(steps[0].volume).toBeLessThanOrEqual(100);
        expect(steps[steps.length - 1].volume).toBe(0);
    });
});
