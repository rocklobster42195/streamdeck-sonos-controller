// UPnP AVTransport RelTime/TrackDuration ("H:MM:SS") <-> seconds. Used by everything that reads
// GetPositionInfo (previous-restart threshold, progress bars, seek) — was copied per caller.

/** "H:MM:SS" -> seconds; 0 for empty/"NOT_IMPLEMENTED"/malformed values. */
export function parseRelTime(t: string): number {
    if (!t || t === 'NOT_IMPLEMENTED') return 0;
    const parts = t.split(':').map(Number);
    return (parts.length === 3 && parts.every(n => !isNaN(n)))
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : 0;
}

/** Seconds -> "H:MM:SS" as the Seek action's REL_TIME target expects. */
export function formatRelTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
