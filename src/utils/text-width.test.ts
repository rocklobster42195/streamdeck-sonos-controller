import { describe, expect, it } from "vitest";
import { measureArialWidth, truncateToWidth } from "./text-width";

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

describe("truncateToWidth", () => {
    it("returns short text unchanged", () => {
        expect(truncateToWidth("Sonos", 20, 500)).toBe("Sonos");
    });

    it("truncates long text and appends an ellipsis", () => {
        const long = "Science (feat. Stevie Appleton) - Radio Edit";
        const result = truncateToWidth(long, 20, 200);
        expect(result.endsWith("…")).toBe(true);
        expect(result.length).toBeLessThan(long.length);
        expect(measureArialWidth(result, 20)).toBeLessThanOrEqual(200);
    });

    it("never exceeds maxWidth, across a range of widths", () => {
        const long = "Mermaid (Rebecca & Fiona Remix) - Radio Edit";
        for (const w of [20, 40, 80, 120, 250, 600]) {
            expect(measureArialWidth(truncateToWidth(long, 20, w), 20)).toBeLessThanOrEqual(w);
        }
    });

    it("trims trailing whitespace left dangling right before the ellipsis", () => {
        const result = truncateToWidth("word word word word", 20, 90);
        expect(result).not.toMatch(/\s…$/);
    });

    it("falls back to a bare ellipsis when even one character doesn't fit", () => {
        expect(truncateToWidth("Wide title", 20, 1)).toBe("…");
    });

    it("is idempotent — truncating an already-truncated string changes nothing", () => {
        const once = truncateToWidth("A reasonably long track title here", 20, 150);
        expect(truncateToWidth(once, 20, 150)).toBe(once);
    });
});
