import streamDeck, {
    action,
    DialRotateEvent,
    DialDownEvent,
    TouchTapEvent,
    SingletonAction,
    WillAppearEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
    SendToPluginEvent,
} from "@elgato/streamdeck";
import { type JsonValue } from "@elgato/utils";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { getDominantColor } from "../utils/colorExtract";

type ViewMode = 'cover' | 'list';
type Settings = { deviceIp?: string; viewMode?: ViewMode };

interface QueueTrack {
    title: string;
    artist: string;
    artUri?: string;
}

interface QueueState {
    tracks: QueueTrack[];
    totalTracks: number;
    browseIndex: number;
    playingIndex: number;   // 0-based; -1 if radio / nothing playing
    dominantColor: string;
    coverCache: Map<number, string | undefined>;
    viewMode: ViewMode;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function xmlEsc(s: string): string {
    return s.replace(/[<>&"']/g, c =>
        ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}

async function fetchCover(ip: string, artUri: string | undefined): Promise<string | undefined> {
    if (!artUri) return undefined;
    const url = artUri.startsWith('http') ? artUri : `http://${ip}:1400${artUri}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return undefined;
        const buf = await res.arrayBuffer();
        const ct = res.headers.get('content-type') || 'image/jpeg';
        return `data:${ct};base64,${Buffer.from(buf).toString('base64')}`;
    } catch { return undefined; }
}

const EMPTY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">'
    + '<rect width="200" height="100" fill="#0a0a0a"/>'
    + '<text x="100" y="43" fill="#2a2a2a" font-family="Arial,sans-serif" font-size="34" text-anchor="middle">♫</text>'
    + '<text x="100" y="64" fill="#333" font-family="Arial,sans-serif" font-size="10" text-anchor="middle" letter-spacing="2">NO QUEUE</text>'
    + '</svg>';

function queueProgressBar(playingIndex: number, totalTracks: number, color: string): string {
    if (playingIndex < 0 || totalTracks === 0) return '';
    const w = Math.max(2, Math.round((playingIndex + 1) / totalTracks * 200));
    return `<rect x="0" y="97" width="200" height="3" fill="#1a1a1a"/>`
        + `<rect x="0" y="97" width="${w}" height="3" fill="${color}"/>`;
}

function buildCoverSvg(state: QueueState, flash: boolean): string {
    const { tracks, browseIndex, playingIndex, dominantColor, coverCache } = state;
    const isAtPlaying = playingIndex >= 0 && browseIndex === playingIndex;
    const accentColor = isAtPlaying ? dominantColor : '#888888';
    const track = tracks[browseIndex];
    const coverUri = coverCache.get(browseIndex);
    const posText = `${browseIndex + 1} / ${state.totalTracks}`;

    const coverEl = coverUri
        ? `<image href="${coverUri}" x="2" y="12" width="76" height="76" preserveAspectRatio="xMidYMid slice"/>`
        : `<rect x="2" y="12" width="76" height="76" fill="#1a1a1a" rx="3"/>`;

    const playDot = isAtPlaying
        ? `<circle cx="89" cy="77" r="4" fill="${accentColor}"/>`
        : '';
    const posX = isAtPlaying ? 148 : 137;
    const flashOverlay = flash
        ? `<rect x="80" y="0" width="120" height="100" fill="${accentColor}" opacity="0.18" rx="4"/>`
        : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">`
        + `<defs>`
        + `<clipPath id="tc"><rect x="84" y="16" width="113" height="20"/></clipPath>`
        + `<clipPath id="ac"><rect x="84" y="38" width="113" height="16"/></clipPath>`
        + `</defs>`
        + `<rect width="200" height="100" fill="#0a0a0a"/>`
        + coverEl
        + flashOverlay
        + `<text x="84" y="32" fill="${accentColor}" font-family="Arial,sans-serif" font-size="13" clip-path="url(#tc)">${xmlEsc(track?.title ?? '')}</text>`
        + `<text x="84" y="52" fill="#666" font-family="Arial,sans-serif" font-size="11" clip-path="url(#ac)">${xmlEsc(track?.artist ?? '')}</text>`
        + playDot
        + `<text x="${posX}" y="80" fill="${accentColor}" font-family="Arial,sans-serif" font-size="18" font-weight="bold" text-anchor="middle">${posText}</text>`
        + queueProgressBar(playingIndex, state.totalTracks, dominantColor)
        + `</svg>`;
}

function buildListSvg(state: QueueState, flash: boolean): string {
    const { tracks, browseIndex, playingIndex, dominantColor } = state;
    const isAtPlaying = playingIndex >= 0 && browseIndex === playingIndex;
    const accentColor = isAtPlaying ? dominantColor : '#FFFFFF';
    const posText = `${browseIndex + 1}/${state.totalTracks}`;

    const prevTrack = browseIndex > 0 ? tracks[browseIndex - 1] : null;
    const currTrack = tracks[browseIndex];
    const nextTrack = browseIndex < state.totalTracks - 1 ? tracks[browseIndex + 1] : null;

    const flashOverlay = flash
        ? `<rect x="0" y="28" width="200" height="44" fill="${accentColor}" opacity="0.12" rx="2"/>`
        : '';

    // playing dot before center row title
    const playDot = isAtPlaying
        ? `<circle cx="9" cy="52" r="4" fill="${accentColor}"/>`
        : '';
    const textX = isAtPlaying ? 20 : 10;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">`
        + `<defs>`
        + `<clipPath id="p"><rect x="10" y="8" width="150" height="20"/></clipPath>`
        + `<clipPath id="c"><rect x="${textX}" y="34" width="${190 - textX}" height="22"/></clipPath>`
        + `<clipPath id="n"><rect x="10" y="70" width="150" height="20"/></clipPath>`
        + `</defs>`
        + `<rect width="200" height="100" fill="#0a0a0a"/>`
        + flashOverlay
        // previous
        + (prevTrack ? `<text x="10" y="23" fill="#444" font-family="Arial,sans-serif" font-size="11" clip-path="url(#p)">${xmlEsc(prevTrack.title)}</text>` : '')
        // separator lines
        + `<line x1="0" y1="30" x2="200" y2="30" stroke="#1e1e1e" stroke-width="1"/>`
        + `<line x1="0" y1="70" x2="200" y2="70" stroke="#1e1e1e" stroke-width="1"/>`
        // current (center)
        + flashOverlay
        + playDot
        + `<text x="${textX}" y="52" fill="${accentColor}" font-family="Arial,sans-serif" font-size="14" font-weight="bold" clip-path="url(#c)">${xmlEsc(currTrack?.title ?? '')}</text>`
        // next
        + (nextTrack ? `<text x="10" y="84" fill="#444" font-family="Arial,sans-serif" font-size="11" clip-path="url(#n)">${xmlEsc(nextTrack.title)}</text>` : '')
        // position top-right
        + `<text x="197" y="23" fill="#333" font-family="Arial,sans-serif" font-size="10" text-anchor="end">${posText}</text>`
        + queueProgressBar(playingIndex, state.totalTracks, dominantColor)
        + `</svg>`;
}

function buildSvg(state: QueueState, flash = false): string {
    if (state.totalTracks === 0) return EMPTY_SVG;
    return state.viewMode === 'list'
        ? buildListSvg(state, flash)
        : buildCoverSvg(state, flash);
}

// ── action ────────────────────────────────────────────────────────────────────

@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-queue" })
export class SonosDialQueue extends SingletonAction<Settings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, QueueState> = new Map();
    private settingsMap: Map<string, Settings> = new Map();
    private avListeners: Map<string, (evt: any) => void> = new Map();
    private queueListeners: Map<string, (evt: any) => void> = new Map();

    // ── rendering ─────────────────────────────────────────────────────────────

    private async renderDial(context: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(context);
        if (!sdAction?.isDial()) return;
        const state = this.states.get(context);
        if (!state) return;
        const svg = buildSvg(state);
        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        }).catch(() => {});
    }

    private async renderFlash(context: string, durationMs = 350): Promise<void> {
        const state = this.states.get(context);
        const sdAction = streamDeck.actions.getActionById(context);
        if (!state || !sdAction?.isDial()) return;
        const svg = buildSvg(state, true);
        await sdAction.setFeedback({
            'full-canvas': `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        }).catch(() => {});
        await new Promise(r => setTimeout(r, durationMs));
        await this.renderDial(context);
    }

    // Fetch cover for a given queue index, cache it, then re-render.
    private async loadCoverForIndex(context: string, index: number): Promise<void> {
        const state = this.states.get(context);
        const settings = this.settingsMap.get(context);
        if (!state || !settings?.deviceIp) return;
        if (state.coverCache.has(index)) return;

        const artUri = state.tracks[index]?.artUri;
        // mark as loading to avoid duplicate fetches
        state.coverCache.set(index, undefined);
        const dataUri = await fetchCover(settings.deviceIp, artUri);
        state.coverCache.set(index, dataUri);

        // extract dominant color when loading the playing track's cover
        if (index === state.playingIndex && dataUri) {
            const color = await getDominantColor(dataUri).catch(() => '#FFFFFF');
            state.dominantColor = color || '#FFFFFF';
        }

        await this.renderDial(context);
    }

    // ── queue loading ─────────────────────────────────────────────────────────

    private async loadQueue(context: string): Promise<void> {
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;

        try {
            const resp = await controller.sonosDevice.QueueService.Browse({
                QueueID: 0, StartingIndex: 0, RequestedCount: 500,
            });
            const raw = Array.isArray(resp.Result) ? resp.Result : [];
            state.tracks = raw.map((t: any) => ({
                title: t.Title ?? '',
                artist: t.Artist ?? '',
                artUri: t.AlbumArtUri,
            }));
            state.totalTracks = resp.TotalMatches;
            state.coverCache = new Map();

            // clamp indices
            const max = Math.max(0, state.totalTracks - 1);
            state.browseIndex = Math.min(state.browseIndex, max);
            if (state.playingIndex > max) state.playingIndex = -1;
        } catch (e) {
            streamDeck.logger.warn('QueueService.Browse failed', e);
            state.tracks = [];
            state.totalTracks = 0;
        }

        await this.renderDial(context);
        // pre-fetch cover for the current browse position
        void this.loadCoverForIndex(context, state.browseIndex);
    }

    // ── setup / teardown ──────────────────────────────────────────────────────

    private cleanupInstance(context: string): void {
        const controller = this.controllers.get(context);
        if (controller) {
            const avL = this.avListeners.get(context);
            if (avL) controller.sonosDevice.AVTransportService.Events.removeListener('serviceEvent', avL);
            const qL = this.queueListeners.get(context);
            if (qL) controller.sonosDevice.QueueService.Events.removeListener('serviceEvent', qL);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }
        this.avListeners.delete(context);
        this.queueListeners.delete(context);
        this.states.delete(context);
        this.settingsMap.delete(context);
    }

    private async onInstanceUpdate(ev: WillAppearEvent<Settings> | DidReceiveSettingsEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const settings = ev.payload.settings;
        this.cleanupInstance(context);
        this.settingsMap.set(context, settings);

        if (!settings.deviceIp) {
            if (ev.action.isDial()) await ev.action.setFeedback({ 'full-canvas': '' }).catch(() => {});
            return;
        }

        await discoveryPromise;

        try {
            const controller = await sonosDeviceManager.getController(settings.deviceIp);
            this.controllers.set(context, controller);

            const state: QueueState = {
                tracks: [], totalTracks: 0,
                browseIndex: 0, playingIndex: -1,
                dominantColor: '#FFFFFF',
                coverCache: new Map(),
                viewMode: settings.viewMode ?? 'cover',
            };
            this.states.set(context, state);

            // Get current track position
            const posInfo = await controller.sonosDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
            if (posInfo.Track > 0) {
                state.playingIndex = posInfo.Track - 1;
                state.browseIndex = state.playingIndex;
            }

            // Subscribe to AVTransport events for track changes
            const avListener = (evt: any) => {
                const s = this.states.get(context);
                if (!s || evt.CurrentTrack === undefined) return;
                const newIdx = (evt.CurrentTrack as number) - 1;
                const wasAtPlaying = s.browseIndex === s.playingIndex;
                s.playingIndex = newIdx;
                if (wasAtPlaying) s.browseIndex = newIdx;
                void this.loadCoverForIndex(context, s.browseIndex);
                void this.renderDial(context);
            };
            this.avListeners.set(context, avListener);
            controller.sonosDevice.AVTransportService.Events.on('serviceEvent', avListener);

            // Subscribe to Queue events for queue changes
            const queueListener = (evt: any) => {
                if (evt.UpdateID !== undefined) void this.loadQueue(context);
            };
            this.queueListeners.set(context, queueListener);
            controller.sonosDevice.QueueService.Events.on('serviceEvent', queueListener);

            // Load queue immediately
            await this.loadQueue(context);

        } catch (e) {
            streamDeck.logger.error(`SonosDialQueue: error for ${settings.deviceIp}`, e);
        }
    }

    override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
    }

    // ── interactions ──────────────────────────────────────────────────────────

    override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state || state.totalTracks === 0) return;

        const step = Math.abs(ev.payload.ticks) > 3 ? ev.payload.ticks * 2 : ev.payload.ticks;
        state.browseIndex = Math.max(0, Math.min(state.totalTracks - 1, state.browseIndex + step));

        await this.renderDial(context);
        void this.loadCoverForIndex(context, state.browseIndex);
    }

    override async onDialDown(ev: DialDownEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        const controller = this.controllers.get(context);
        if (!state || !controller || state.totalTracks === 0) return;

        if (state.browseIndex === state.playingIndex) return;

        try {
            await controller.sonosDevice.AVTransportService.Seek({
                InstanceID: 0,
                Unit: 'TRACK_NR',
                Target: String(state.browseIndex + 1),
            });
            state.playingIndex = state.browseIndex;
            void this.renderFlash(context);
        } catch (e) {
            streamDeck.logger.warn('AVTransportService.Seek failed', e);
            streamDeck.actions.getActionById(context)?.showAlert();
        }
    }

    override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
        const context = ev.action.id;
        const state = this.states.get(context);
        if (!state) return;

        if (state.playingIndex >= 0) state.browseIndex = state.playingIndex;
        void this.renderFlash(context);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
        if (typeof ev.payload !== 'object' || ev.payload === null || !('event' in ev.payload)) return;
        if (ev.payload.event === 'get-devices') {
            await discoveryPromise;
            const items = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
            streamDeck.ui.sendToPropertyInspector({ event: 'get-devices', items });
        }
    }
}
