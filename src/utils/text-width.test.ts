import { describe, expect, it } from "vitest";
import { measureArialWidth } from "./text-width";

describe("measureArialWidth", () => {
    it("returns 0 for empty text", () => {
        expect(measureArialWidth("", 20)).toBe(0);
    });

    it("distinguishes narrow and wide glyphs instead of counting characters", () => {
        const narrow = measureArialWidth("iiii", 20); // i = 222/1000
        const wide = measureArialWidth("MMMM", 20);   // M = 833/1000
        expect(narrow).toBeLessThan(wide / 2);
    });

    it("matches known Arial metrics exactly", () => {
        // "ill" = 222+222+222 = 666/1000 em → 13.32px @ 20px → ceil 14
        expect(measureArialWidth("ill", 20)).toBe(14);
        // digits are 556/1000 each: "2026" @ 10px → 4 * 5.56 = 22.24 → ceil 23
        expect(measureArialWidth("2026", 10)).toBe(23);
    });

    it("scales linearly with font size", () => {
        const at10 = measureArialWidth("Sonos Panorama", 10);
        const at20 = measureArialWidth("Sonos Panorama", 20);
        expect(at20).toBeGreaterThanOrEqual(at10 * 2 - 1);
        expect(at20).toBeLessThanOrEqual(at10 * 2 + 1);
    });

    it("treats accented characters like their base letters", () => {
        expect(measureArialWidth("äöü", 20)).toBe(measureArialWidth("aou", 20));
        expect(measureArialWidth("Éléphant", 20)).toBe(measureArialWidth("Elephant", 20));
    });

    it("stays well below the old char-count heuristic for lowercase text", () => {
        const text = "die längsten deutschen songtitel aller zeiten";
        const old = Math.ceil(text.length * 20 * 0.58) + 4;
        expect(measureArialWidth(text, 20)).toBeLessThan(old * 0.92);
    });
});
