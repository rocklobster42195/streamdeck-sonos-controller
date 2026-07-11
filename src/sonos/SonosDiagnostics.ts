import { withTimeout } from "../utils/fetchWithTimeout";

// Sonos speakers expose an UNDOCUMENTED local diagnostic page at this path (part of the same
// "support review" info the Sonos app itself pulls when a user submits a diagnostic report) —
// not part of the official UPnP/SOAP API this plugin otherwise uses everywhere else. Confirmed
// working manually against real hardware (PowerShell Invoke-WebRequest) while debugging a flaky
// stereo-pair speaker, but it's unofficial: Sonos could change or remove it in any firmware update
// without notice. Acceptable for a "nerdy" power-user diagnostics dial — do not depend on it for
// anything else.
const DIAGNOSTICS_PATH = '/status/proc/ath_rincon/status';
const FETCH_TIMEOUT_MS = 4000;

export interface SonosDiagnosticsSample {
    /** Round-trip time of the diagnostic fetch itself, in ms — used as a rough reachability/
     *  connection-quality proxy. `null` if the fetch failed or timed out. */
    latencyMs: number | null;
    /** Chain-0 noise floor in dBm, parsed from the radio driver's own debug dump. A reading of
     *  exactly 0 is not a real noise floor (real values are large negative numbers, e.g. -90 to
     *  -110) — it means the radio hadn't calibrated/measured at the time of the read, which is
     *  itself diagnostically interesting (seen on a speaker with intermittent connectivity). */
    noiseFloorDbm: number | null;
    /** Cumulative PHY error counter since the radio driver's last reset — NOT a rate. Callers
     *  wanting a rate should diff consecutive samples themselves (see sonos-dial-diagnostics.ts). */
    phyErrorsCumulative: number | null;
}

function parseNumber(text: string, pattern: RegExp): number | null {
    const m = text.match(pattern);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

/** Fetches and parses one speaker's local diagnostic page. Never throws — every field is `null`
 *  on fetch failure/timeout or parse miss, so one bad field (or a fully unreachable speaker,
 *  exactly the case this tool exists to surface) doesn't prevent a sample being recorded. */
export async function fetchDiagnosticsSample(deviceIp: string): Promise<SonosDiagnosticsSample> {
    const start = Date.now();
    try {
        const response = await withTimeout(
            fetch(`http://${deviceIp}:1400${DIAGNOSTICS_PATH}`),
            FETCH_TIMEOUT_MS,
            `diagnostics fetch (${deviceIp})`,
        );
        const latencyMs = Date.now() - start;
        if (!response.ok) return { latencyMs, noiseFloorDbm: null, phyErrorsCumulative: null };
        const text = await response.text();
        return {
            latencyMs,
            noiseFloorDbm: parseNumber(text, /Noise Floor:\s*(-?\d+)\s*dBm\s*\(chain 0/),
            phyErrorsCumulative: parseNumber(text, /PHY errors since last reading\/reset:\s*(\d+)/),
        };
    } catch {
        // Timed out or the connection itself failed (e.g. ETIMEDOUT to an unreachable speaker) —
        // exactly the case this tool is meant to surface, so report it as "no reading" rather
        // than propagating the error.
        return { latencyMs: null, noiseFloorDbm: null, phyErrorsCumulative: null };
    }
}
