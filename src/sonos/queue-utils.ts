import { BrowseResponse, Track } from "@svrooij/sonos/lib/models";

// GetQueue()'s Result comes back as a plain string instead of Track[] on empty/degenerate
// responses (e.g. NumberReturned === 0) — normalize that away for callers.
export function normalizeBrowseResult(resp: BrowseResponse): Track[] {
    return Array.isArray(resp.Result) ? resp.Result : [];
}

// Wraps `current + delta` into [0, length). Used by Rotate to move the preview cursor through
// the queue without falling off either end.
export function wrapIndex(current: number, delta: number, length: number): number {
    if (length <= 0) return -1;
    return ((current + delta) % length + length) % length;
}

// Cheap ellipsis truncation for the carousel's static neighbor rows (never scroll, so Track
// Dial's binary-search text measurement is unnecessary precision here).
export function truncateForDisplay(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    if (maxChars <= 1) return text.slice(0, maxChars);
    return text.slice(0, maxChars - 1) + "…";
}
