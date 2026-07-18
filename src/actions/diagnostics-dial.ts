import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    SingletonAction,
    DialDownEvent,
    TouchTapEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { fetchDiagnosticsSample } from "../sonos/SonosDiagnostics";
import { buildUnconfiguredDialSvg } from "../utils/icons";
import { sendDeviceList } from "./pi-options";

// Nerdy power-user tool built while tracking down a real flaky-speaker issue — see
// src/sonos/SonosDiagnostics.ts for why this reads an UNOFFICIAL Sonos endpoint. Not meant to be
// a robust supported feature; if the endpoint disappears in a future Sonos firmware update, this
// dial just stops updating (fetchDiagnosticsSample never throws, so it fails quiet, not loud).

type SonosDiagnosticsSettings = {
    deviceIp?: string;
};

const POLL_INTERVAL_MS = 3000;
const MAX_SAMPLES = 30;
// Ceiling used as a visible "failure spike" in the latency sparkline when a poll times out or the
// speaker is unreachable — deliberately NOT dropped/skipped, since surfacing unreachability is the
// whole point of this tool.
const LATENCY_FAILURE_SPIKE_MS = 4000;

interface Metric {
    label: string;
    color: string;
    unit: string;
}

const METRICS: Metric[] = [
    { label: 'Latency', color: '#5DADE2', unit: 'ms' },
    { label: 'PHY Errors', color: '#E67E22', unit: '/poll' },
    { label: 'Noise Floor', color: '#58D68D', unit: 'dBm' },
];

interface DialState {
    metricIndex: number;
    // One rolling sample window per metric (index-aligned with METRICS) — switching metrics via
    // press keeps each metric's own history instead of showing a blank graph.
    samples: number[][];
    lastPhyErrorsCumulative: number | null;
}

function pushSample(samples: number[], value: number): void {
    samples.push(value);
    if (samples.length > MAX_SAMPLES) samples.shift();
}

// Auto-scales to the current window's own min/max — simplest thing that reads sensibly across
// three very differently-scaled metrics (ms, error count, dBm) without hardcoding per-metric
// ranges. A flat/near-flat window still draws a visible flat line rather than nothing.
function buildSparklineSvg(samples: number[], width: number, height: number, color: string): string {
    if (samples.length === 0) return '';
    if (samples.length === 1) {
        const y = height / 2;
        return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${color}" stroke-width="2" opacity="0.8"/>`;
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const range = max - min || 1;
    const stepX = width / (samples.length - 1);
    const points = samples.map((v, i) => {
        const x = (i * stepX).toFixed(1);
        const y = (height - 4 - ((v - min) / range) * (height - 8)).toFixed(1);
        return `${x},${y}`;
    }).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" opacity="0.85"/>`;
}

@action({ UUID: "de.boriskemper.sonos-controller.diagnostics-dial" })
export class DiagnosticsDial extends SingletonAction<SonosDiagnosticsSettings> {
    private settingsMap: Map<string, SonosDiagnosticsSettings> = new Map();
    private states: Map<string, DialState> = new Map();
    private pollTimers: Map<string, NodeJS.Timeout> = new Map();

    private newState(): DialState {
        return { metricIndex: 0, samples: METRICS.map(() => []), lastPhyErrorsCumulative: null };
    }

    private async poll(context: string): Promise<void> {
        const settings = this.settingsMap.get(context);
        const state = this.states.get(context);
        if (!settings?.deviceIp || !state) return;

        const sample = await fetchDiagnosticsSample(settings.deviceIp);
        // Still the current tile? (guards against a stale in-flight poll racing a fast
        // reconfigure/removal).
        if (this.states.get(context) !== state) return;

        pushSample(state.samples[0], sample.latencyMs ?? LATENCY_FAILURE_SPIKE_MS);

        if (sample.phyErrorsCumulative !== null) {
            if (state.lastPhyErrorsCumulative !== null) {
                const delta = Math.max(0, sample.phyErrorsCumulative - state.lastPhyErrorsCumulative);
                pushSample(state.samples[1], delta);
            }
            state.lastPhyErrorsCumulative = sample.phyErrorsCumulative;
        }

        if (sample.noiseFloorDbm !== null) pushSample(state.samples[2], sample.noiseFloorDbm);

        void this.renderDial(context);
    }

    private startPolling(context: string): void {
        this.stopPolling(context);
        void this.poll(context);
        this.pollTimers.set(context, setInterval(() => void this.poll(context), POLL_INTERVAL_MS));
    }

    private stopPolling(context: string): void {
        const timer = this.pollTimers.get(context);
        if (timer) { clearInterval(timer); this.pollTimers.delete(context); }
    }

    private cleanupInstance(context: string): void {
        this.stopPolling(context);
        this.settingsMap.delete(context);
        this.states.delete(context);
    }

    async onInstanceUpdate(ev: WillAppearEvent<SonosDiagnosticsSettings> | DidReceiveSettingsEvent<SonosDiagnosticsSettings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;
        const deviceChanged = this.settingsMap.get(context)?.deviceIp !== settings.deviceIp;

        this.settingsMap.set(context, settings);
        if (!this.states.has(context) || deviceChanged) this.states.set(context, this.newState());

        if (!settings.deviceIp) {
            this.stopPolling(context);
            void this.renderDial(context);
            return;
        }

        this.startPolling(context);
    }

    override async onWillAppear(ev: WillAppearEvent<SonosDiagnosticsSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosDiagnosticsSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosDiagnosticsSettings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
    }

    // Press cycles through metrics.
    override async onDialDown(ev: DialDownEvent<SonosDiagnosticsSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        state.metricIndex = (state.metricIndex + 1) % METRICS.length;
        void this.renderDial(context);
    }

    // Tap for an immediate refresh instead of waiting for the next poll tick.
    override async onTouchTap(ev: TouchTapEvent<SonosDiagnosticsSettings>): Promise<void> {
        void this.poll(ev.action.id);
    }

    // Rotate scrolls through metrics — one step per event regardless of how many detents Stream
    // Deck coalesced into `ticks`, so a fast spin steps predictably instead of skipping past
    // multiple metrics in a 3-item list.
    override async onDialRotate(ev: DialRotateEvent<SonosDiagnosticsSettings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;
        const step = Math.sign(ev.payload.ticks);
        if (step === 0) return;
        state.metricIndex = (state.metricIndex + step + METRICS.length) % METRICS.length;
        void this.renderDial(context);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosDiagnosticsSettings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        if (ev.payload.event === 'get-devices') await sendDeviceList('-- Choose device --', (await ev.action.getSettings()).deviceIp);
    }

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction?.isDial()) return;

        const settings = this.settingsMap.get(context);
        if (!settings?.deviceIp) {
            const svg = buildUnconfiguredDialSvg('DIAG');
            await sdAction.setFeedback({
                'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
                'title': '',
            }).catch(() => {});
            return;
        }

        const state = this.states.get(context);
        const metric = METRICS[state?.metricIndex ?? 0];
        const samples = state?.samples[state?.metricIndex ?? 0] ?? [];
        const latest = samples.length > 0 ? samples[samples.length - 1] : undefined;
        const valueText = latest === undefined ? '—' : `${Math.round(latest)} ${metric.unit}`;

        const sparkline = buildSparklineSvg(samples, 200, 100, metric.color);

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<rect width="200" height="100" fill="#0a0a0a"/>',
            sparkline,
            '<rect x="0" y="0" width="200" height="24" fill="#000" fill-opacity="0.55"/>',
            `<text x="8" y="16" fill="${metric.color}" font-family="Arial,sans-serif" font-size="12" font-weight="bold">${metric.label}</text>`,
            `<rect x="0" y="76" width="200" height="24" fill="#000" fill-opacity="0.55"/>`,
            `<text x="192" y="92" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="14" font-weight="bold" text-anchor="end">${valueText}</text>`,
            '</svg>',
        ].join('');

        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
            'title': '',
        }).catch(() => {});
    }
}
