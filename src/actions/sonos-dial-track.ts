import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialRotateEvent,
    WillAppearEvent,
    SingletonAction,
    DialDownEvent,
    SendToPluginEvent,
    DidReceiveSettingsEvent,
    WillDisappearEvent,
    TouchTapEvent
} from "@elgato/streamdeck";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { generateFaderSvg } from "../sonos/utils";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { sonosManager, discoveryPromise } from "../sonos/sonos-discovery";
import { SonosDevice } from "@svrooij/sonos";
import { CoverArtAnimator } from "../utils/CoverArtAnimator";
import { titleAnimator } from "../utils/TitleAnimator"; // ADDED
import { marqueeAnimator } from "../utils/MarqueeAnimator";
import { TrackInfo, VolumeInfo } from "../sonos/SonosTypes";

/**
 * Settings for {@link SonosDialTrack}.
 */
type SonosSettings = {
    deviceIp?: string;
    showTrackTitle?: boolean; // ADDED
    showCoverArt?: boolean; // ADDED
    fontColor?: string; // ADDED
    fontSize?: number; // ADDED
    marqueeSpeed?: number;
    marqueePause?: number;
    enableMarquee?: boolean;
};

interface DialState {
    volume: number;
    isMuted: boolean;
    trackInfo?: TrackInfo;
}

/**
 * A dial action that displays the current track, cover art and provides volume control.
 */
@action({ UUID: "de.boriskemper.sonos-controller.sonos-dial-track" })
export class SonosDialTrack extends SingletonAction<SonosSettings> {
    private controllers: Map<string, SonosDeviceController> = new Map();
    private states: Map<string, DialState> = new Map();
    private animators: Map<string, CoverArtAnimator> = new Map();
    private settingsMap: Map<string, SonosSettings> = new Map();
    private marqueeTimers: Map<string, NodeJS.Timeout> = new Map();

    private onVolumeInfoChanged(context: string, volumeInfo: VolumeInfo): void {
        const state = this.states.get(context);
        if (state) {
            state.volume = volumeInfo.volume;
            state.isMuted = volumeInfo.mute;
            this.renderDial(context);
        }
    }

    private async onTrackInfoChanged(context: string, trackInfo: TrackInfo): Promise<void> {
        const state = this.states.get(context);
        const animator = this.animators.get(context);
        if (state && animator) {
            state.trackInfo = trackInfo;
            animator.updateImage(context, trackInfo.albumArtDataUri);
            // Update marquee text (title) using truncation preview + delayed full scroll
            const settings = this.settingsMap.get(context);
            const text = trackInfo.Title ? `${trackInfo.Title}` : trackInfo.Title || '';
            const fontSize = settings?.fontSize ?? 14;
            const gapRight = 5; // px gap between text and cover
            const availWidth = 100 - gapRight; // ensure small spacing to cover
            await this.updateTitleMarquee(context, text, fontSize, availWidth, settings);
            this.renderDial(context);
        }
    }

    private estimateTextWidth(text: string, fontSize: number): number {
        // same estimation as MarqueeAnimator
        const factor = 0.55;
        const padding = 4;
        return Math.max(0, Math.ceil(text.length * fontSize * factor) + padding);
    }

    // Compute a truncated version of `text` that fits into `availableWidth` when rendered with `fontSize`.
    private async computeTruncatedText(text: string, fontSize: number, availableWidth: number): Promise<string> {
        // quick path
        try {
            const fullWidth = await titleAnimator.measure(text, fontSize);
            if (fullWidth <= availableWidth) return text;
        } catch {
            // ignore, we'll fallback to estimate
        }

        // binary search for maximum chars that fit with trailing ellipsis
        let lo = 0;
        let hi = text.length;
        let best = '';
        while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const candidate = text.substring(0, mid) + '…';
            let w: number;
            try {
                w = await titleAnimator.measure(candidate, fontSize);
            } catch {
                w = this.estimateTextWidth(candidate, fontSize);
            }
            if (w <= availableWidth) {
                best = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        return best || text.substring(0, Math.max(0, Math.floor((availableWidth / (fontSize * 0.55)) - 1))) + '…';
    }

    // Update marquee for title: show truncated preview, then after delay start the full scrolling text
    private async updateTitleMarquee(context: string, fullText: string, fontSize: number, availableWidth: number, settings?: SonosSettings) {
        // clear previous timer
        const prev = this.marqueeTimers.get(context);
        if (prev) {
            clearTimeout(prev);
            this.marqueeTimers.delete(context);
        }

        // measure full text
        let measuredFull: number | undefined = undefined;
        try {
            measuredFull = await titleAnimator.measure(fullText, fontSize);
            streamDeck.logger.debug(`[updateTitleMarquee] measuredFull=${measuredFull} for "${fullText.substring(0,30)}..."`);
        } catch (e) {
            streamDeck.logger.debug(`[updateTitleMarquee] measure failed, will estimate`);
        }

        // If fits, show full static
        if ((measuredFull ?? this.estimateTextWidth(fullText, fontSize)) <= availableWidth) {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor: settings?.fontColor ?? '#FFFFFF', speed: settings?.marqueeSpeed, pauseDuration: settings?.marqueePause, measuredWidth: measuredFull, availableWidth });
            return;
        }

        // Compute truncated preview that fits with ellipsis
        const preview = await this.computeTruncatedText(fullText, fontSize, availableWidth);
        let measuredPreview: number | undefined = undefined;
        try {
            measuredPreview = await titleAnimator.measure(preview, fontSize);
        } catch {
            measuredPreview = this.estimateTextWidth(preview, fontSize);
        }

        // Show preview (no scrolling expected)
        marqueeAnimator.update(context, { text: preview, fontSize, fontColor: settings?.fontColor ?? '#FFFFFF', speed: settings?.marqueeSpeed, pauseDuration: settings?.marqueePause, measuredWidth: measuredPreview, availableWidth });

        // After a pause, switch to full text and enable scrolling
        const initialPause = 1500; // ms
        const t = setTimeout(() => {
            marqueeAnimator.update(context, { text: fullText, fontSize, fontColor: settings?.fontColor ?? '#FFFFFF', speed: settings?.marqueeSpeed, pauseDuration: settings?.marqueePause, measuredWidth: measuredFull, availableWidth });
            this.marqueeTimers.delete(context);
        }, initialPause);
        this.marqueeTimers.set(context, t);
    }

async onInstanceUpdate(ev: WillAppearEvent<SonosSettings> | DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
    const context = ev.action.id;
    const { deviceIp } = ev.payload.settings;

    // store settings for this context
    this.settingsMap.set(context, ev.payload.settings);

    this.cleanupInstance(context);

    // Animator initialisieren (wichtig für später, falls wir scrollen wollen)
    const animator = new CoverArtAnimator();
    this.animators.set(context, animator);
    animator.start(context, () => this.renderDial(context));

    // Marquee initialisieren (transparent scroll text) only when titles should be shown
        // Marquee initialisieren (transparent scroll text) — always start so it can decide whether to scroll
        marqueeAnimator.start(context, () => this.renderDial(context), { text: '', fontSize: ev.payload.settings.fontSize ?? 14, fontColor: ev.payload.settings.fontColor ?? '#FFFFFF', speed: ev.payload.settings.marqueeSpeed, pauseDuration: ev.payload.settings.marqueePause, availableWidth: 100 });

    // Standard-State setzen
    this.states.set(context, { volume: 0, isMuted: false });

    // Erstes Rendern (zeigt "Sonos / Bereit")
    await this.renderDial(context);

    if (!deviceIp) {
        return;
    }

    try {
        const controller = await sonosDeviceManager.getController(deviceIp);
        this.controllers.set(context, controller);

        // Callbacks registrieren (für Updates WÄHREND es läuft)
        controller.registerVolumeCallback(context, (volumeInfo) => this.onVolumeInfoChanged(context, volumeInfo));
        controller.registerTrackInfoCallback(context, (trackInfo) => { void this.onTrackInfoChanged(context, trackInfo); });

        // --- DATEN SOFORT HOLEN (WICHTIG!) ---
        // Wir warten nicht auf ein Event, wir holen den Status JETZT.
        const [vol, track] = await Promise.all([
            controller.getVolume(),
            controller.getCurrentTrack()
        ]);

        const state = this.states.get(context)!;
        state.volume = vol.volume;
        state.isMuted = vol.mute;

        if (track) {
            state.trackInfo = track;
            
            // Cover separat holen, wie in deinem Schnipsel
            const cover = await controller.getCurrentTrackCover();
                if (cover) {
                    state.trackInfo.albumArtDataUri = cover;
                    // Dem Animator das Bild geben
                    animator.updateImage(context, cover);
                    // Update marquee text now that track is known (always update marquee state)
                    const settings = this.settingsMap.get(context);
                    const text = track.Title ? `${track.Title}` : '';
                    const fontSize = settings?.fontSize ?? 14;
                    let measured: number | undefined = undefined;
                    try {
                        measured = await titleAnimator.measure(text, fontSize);
                        streamDeck.logger.debug(`[onInstanceUpdate] Measured text width: ${measured}px for "${text.substring(0, 30)}..." (fontSize=${fontSize})`);
                    } catch (err) {
                        streamDeck.logger.debug(`[onInstanceUpdate] Text measurement failed`);
                    }
                    const estimatedWidth = this.estimateTextWidth(text, fontSize);
                    const gapRight = 5;
                    const availWidth = 100 - gapRight;
                    streamDeck.logger.debug(`[onInstanceUpdate] Marquee update: measured=${measured} estimated=${estimatedWidth} available=${availWidth}`);
                    await this.updateTitleMarquee(context, text, fontSize, availWidth, settings);
                }
        }

        // Jetzt mit echten Daten rendern
        await this.renderDial(context);

    } catch (e) {
        streamDeck.logger.error(`Error getting initial state for ${deviceIp}`, e);
    }
}

    override async onWillAppear(ev: WillAppearEvent<SonosSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>): Promise<void> {
        await this.onInstanceUpdate(ev);
    }

    override async onWillDisappear(ev: WillDisappearEvent<SonosSettings>): Promise<void> {
        this.cleanupInstance(ev.action.id);
    }

    private cleanupInstance(context: string): void {
        const controller = this.controllers.get(context);
        if (controller) {
            controller.unregisterVolumeCallback(context);
            controller.unregisterTrackInfoCallback(context);
            sonosDeviceManager.releaseController(controller.deviceIp);
            this.controllers.delete(context);
        }

        const animator = this.animators.get(context);
        if (animator) {
            animator.destroy(context);
            this.animators.delete(context);
        }

        // destroy marquee as well
        marqueeAnimator.destroy(context);

        // clear any pending marquee timers
        const mt = this.marqueeTimers.get(context);
        if (mt) {
            clearTimeout(mt);
            this.marqueeTimers.delete(context);
        }

        this.settingsMap.delete(context);

        this.states.delete(context);
    }

    override async onDialDown(ev: DialDownEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            await controller.toggleMute();
        }
    }

    override async onTouchTap(ev: TouchTapEvent<SonosSettings>): Promise<void> {
        const controller = this.controllers.get(ev.action.id);
        if (controller) {
            await controller.togglePlayPause();
        }
    }

    override async onDialRotate(ev: DialRotateEvent<SonosSettings>): Promise<void> {
        const context = ev.action.id;
        const controller = this.controllers.get(context);
        const state = this.states.get(context);
        if (!controller || !state) return;

        if (state.isMuted) {
            await controller.toggleMute();
        }

        const ticks = ev.payload.ticks;
        const currentVolume = state.volume;
        const volumeChange = ticks * (Math.abs(ticks) > 3 ? 2 : 1);
        const newVolume = Math.min(100, Math.max(0, currentVolume + volumeChange));

        if (newVolume !== currentVolume) {
            await controller.setVolume(newVolume);
        }
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SonosSettings>): Promise<void> {
        if (typeof ev.payload === 'object' && ev.payload !== null && 'event' in ev.payload) {
            if (ev.payload.event === 'get-devices') {
                await discoveryPromise;
                const deviceItems = sonosManager.Devices.map((d: SonosDevice) => ({ label: d.Name, value: d.Host }));
                streamDeck.ui.sendToPropertyInspector({
                    event: 'get-devices',
                    items: [{ label: '-- Choose Device --', value: '' }, ...deviceItems]
                });
            }
        }
    }

private async renderDial(context: string): Promise<void> {
    const action = streamDeck.actions.getActionById(context);
    const state = this.states.get(context);
    
    if (!action || !action.isDial() || !state) {
        return;
    }

    // Daten aus dem State (jetzt hoffentlich gefüllt durch onInstanceUpdate)
    const title = state.trackInfo?.Title || "Sonos";
    const artist = state.trackInfo?.Artist || "Bereit";
    const coverImg = state.trackInfo?.albumArtDataUri || "";
    
    // --- FADER (TORTE) ---
    let faderImg = generateFaderSvg(state.volume, state.isMuted, "#CCCCCC");
    
    // Encoding Check (damit es nicht kaputt geht)
    if (faderImg.trim().startsWith('<svg')) {
        faderImg = `data:image/svg+xml;base64,${Buffer.from(faderImg).toString('base64')}`;
    }

    // --- COVER ART ---
    // Cover maximal groß (rechts), Lauftext nutzt Platz zwischen Rand und Cover
    const coverSvgTag = coverImg 
        ? `<image href="${coverImg}" x="115" y="5" width="85" height="95" preserveAspectRatio="xMidYMid slice" rx="5" />`
        : `<rect x="115" y="5" width="85" height="95" fill="#222222" rx="5" />`;

    // --- MASTER SVG ---
    // Layout $A0 = 200x100 Pixel
    const finalSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
            <!-- Hintergrund -->
            <rect width="200" height="100" fill="black" />

            <!-- Text Oben Links -->
            <!-- Ein großer clipPath für alle Texte: x=10 bis x=110 (100px breit), 15px Abstand zum Cover -->
            <defs>
                <clipPath id="textClipArea"><rect x="10" y="5" width="100" height="50" /></clipPath>
            </defs>
            <g clip-path="url(#textClipArea)">
                ${(() => {
                    const settings = this.settingsMap.get(context);
                    // Show title by default; only hide if explicitly disabled in settings
                    if (settings && settings.showTrackTitle === false) return '';
                    const fontSize = settings?.fontSize ?? 14;
                    // If marquee is active for this context, render title with animation
                    if (marqueeAnimator.isRunning(context)) {
                        const titleFrag = marqueeAnimator.render(context, 10, 25, 100, 20);
                        const artistFrag = `<text x="10" y="42" fill="#AAAAAA" font-family="Arial, sans-serif" font-size="12">${this.escapeXml(artist)}</text>`;
                        return titleFrag + artistFrag;
                    }
                    // Static text if no marquee
                    const titleFrag = `<text x="10" y="25" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold">${this.escapeXml(title)}</text>`;
                    const artistFrag = `<text x="10" y="42" fill="#AAAAAA" font-family="Arial, sans-serif" font-size="12">${this.escapeXml(artist)}</text>`;
                    return titleFrag + artistFrag;
                })()}
            </g>
            <!-- spacer between text area and cover to ensure gap -->
            <rect x="110" y="5" width="5" height="50" fill="black" />
            ${coverSvgTag}
            <!-- FADER (TORTE) -->
            <!-- KORREKTUR: Wir machen es quadratisch (50x50), damit die Torte rund bleibt! -->
            <!-- Positioniert unten links -->
            <image href="${faderImg}" x="10" y="45" width="50" height="50" />

            <!-- COVER RECHTS -->
        </svg>
    `.trim();

    const finalImage = `data:image/svg+xml;base64,${Buffer.from(finalSvg).toString('base64')}`;

    // Update senden
    await action.setFeedback({
        "full-canvas": finalImage,
        "icon": "", 
        "title": "",
        "indicator": { "value": state.isMuted ? 0 : state.volume }
    });
}

// Hilfsfunktion (falls noch nicht vorhanden)
private escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&"']/g, (c) => {
        switch (c) {
            case '<': return '&lt;'; case '>': return '&gt;';
            case '&': return '&amp;'; case '"': return '&quot;';
            case "'": return '&apos;'; default: return c;
        }
    });
}
}