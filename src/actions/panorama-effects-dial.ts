import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialDownEvent,
    DialRotateEvent,
    DidReceiveSettingsEvent,
    SingletonAction,
    WillAppearEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { mdiScatterPlotOutline, mdiSpeedometer, mdiWeatherPouring } from "@mdi/js";
import { measureArialWidth, ROW_COLOR_KEY, RunTextOverlay, type RunText } from "@rocklobster42195/streamdeck-kit";
import { panorama, panoramaRows, socRowState, textRuns } from "../effects/panorama";
import { deckPlayers } from "./deck-players";
import { SONOS_IP_PREFIX } from "./play-pause-migrate";
import { escapeXml } from "../utils/xml";
import { ACCENT_COLOR } from "../utils/icons";
import { piT } from "../utils/pi-i18n";

type PanoramaEffectsSettings = {
    // The old per-dial effect choice — taken over into the row once (socRowState), then the row's.
    effectId?: string;
    // The player whose track the text shows: "" = the active player, "device:<id>", or a player of another plugin.
    player?: string;
    // The speaker of an older version (before players), taken as the choice while `player` is unset.
    deviceIp?: string;
    // Colour without a speaker — taken over into the row's colour once (rowColorTaken), then the row's.
    staticColor?: string;
    showTrackInfo?: boolean;
    [key: string]: JsonValue | undefined;
};

type Instance = {
    settings: PanoramaEffectsSettings;
    deviceId: string;
    column: number;
    /** Which of the effect's values turning changes (index into panoramaRows.tunables). */
    fn: number;
    /** Until when the function badge shows at the top. */
    badgeUntil?: number;
    /** Ticks not yet applied to the row (sent at most every TUNE_MS). */
    pendingTicks: number;
    tuneTimer?: ReturnType<typeof setTimeout>;
};

const BADGE_MS = 1500;
const BADGE_FADE_MS = 300;
const TUNE_MS = 100;
/** Icons of what turning changes (as on MA-C's Panorama dial). */
const CONTROL_ICONS: Record<string, string> = { count: mdiScatterPlotOutline, speed: mdiSpeedometer, density: mdiWeatherPouring };

/**
 * The "Panorama Effects" dial: the row's effect (the kit's Panorama, one effect per row of dials)
 * with nothing else on it — or, with "Show track info", title and artist of its speaker across the
 * Panorama Effects dials next to each other. Rotate tunes the effect (speed, density, …), press
 * switches what turning changes; the values become the row's. The colour is the row's (the
 * Panorama section: a speaker's cover, fixed, or the effect's own).
 */
@action({ UUID: "de.boriskemper.sonos-controller.panorama-effects-dial" })
export class PanoramaEffectsDial extends SingletonAction<PanoramaEffectsSettings> {
    private readonly instances = new Map<string, Instance>();
    private readonly lastImage = new Map<string, string>();
    private readonly lastTitle = new Map<string, string>();
    /** The run's text with the kit's crossfade, in step with the other plugins' dials. */
    private readonly textOverlay = new RunTextOverlay();
    private readonly offPlayers: () => void;

    constructor() {
        super();
        // Players and what they play change over deckbus: every dial takes the new text
        this.offPlayers = deckPlayers.onChange(() => {
            for (const id of this.instances.keys()) this.publishText(id);
        });
    }

    override async onWillAppear(ev: WillAppearEvent<PanoramaEffectsSettings>): Promise<void> {
        if (!ev.action.isDial()) return;
        const id = ev.action.id;
        const column = "coordinates" in ev.payload && ev.payload.coordinates ? ev.payload.coordinates.column : 0;
        this.instances.set(id, { settings: ev.payload.settings, deviceId: ev.action.device.id, column, fn: 0, pendingTicks: 0 });
        panoramaRows.add(id, {
            device: ev.action.device.id,
            column,
            label: () => piT("Panorama"),
            state: () => {
                const s = (this.instances.get(id)?.settings ?? {}) as Record<string, unknown>;
                const state = socRowState(s, (s.effectId as string | undefined) ?? "particles", true);
                // This dial is the effect: it always takes part
                return { ...state, member: true };
            },
            save: (patch) => {
                const inst = this.instances.get(id);
                if (!inst) return;
                inst.settings = { ...inst.settings, ...patch } as PanoramaEffectsSettings;
                void streamDeck.actions.getActionById(id)?.setSettings(inst.settings);
            },
            redraw: () => void this.renderDial(id),
        });
        // Before the row had a colour: no speaker → the static colour (default Sage) becomes the row's
        const s = ev.payload.settings;
        if (s.rowColorTaken !== true && Object.keys(s).length > 0) {
            if (!s.deviceIp) panoramaRows.setRow(ev.action.device.id, { settings: { [ROW_COLOR_KEY]: s.staticColor || "#87AE73" } });
            const inst = this.instances.get(id)!;
            inst.settings = { ...inst.settings, rowColorTaken: true };
            void ev.action.setSettings(inst.settings);
        }
        textRuns.set(id, { device: ev.action.device.id, column }, undefined, () => void this.renderDial(id));
        this.publishText(id);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PanoramaEffectsSettings>): Promise<void> {
        const inst = this.instances.get(ev.action.id);
        if (!inst) return;
        inst.settings = ev.payload.settings;
        panoramaRows.changed(ev.action.id);
        this.publishText(ev.action.id);
        void this.renderDial(ev.action.id);
    }

    override async onWillDisappear(ev: WillDisappearEvent<PanoramaEffectsSettings>): Promise<void> {
        const id = ev.action.id;
        clearTimeout(this.instances.get(id)?.tuneTimer);
        textRuns.remove(id);
        this.instances.delete(id);
        this.lastImage.delete(id);
        panoramaRows.remove(id);
    }

    // Rotate turns the chosen value of the row's effect (density, speed, ...). It goes through the
    // row, so it works also while another plugin's dial runs the effect (this one follows).
    override async onDialRotate(ev: DialRotateEvent<PanoramaEffectsSettings>): Promise<void> {
        const inst = this.instances.get(ev.action.id);
        if (!inst || !panoramaRows.tunables(ev.action.id).length) return;
        inst.pendingTicks += ev.payload.ticks;
        if (!inst.tuneTimer) inst.tuneTimer = setTimeout(() => this.applyTicks(ev.action.id), TUNE_MS);
        this.showBadge(ev.action.id);
    }

    // Press switches what turning changes
    override async onDialDown(ev: DialDownEvent<PanoramaEffectsSettings>): Promise<void> {
        const inst = this.instances.get(ev.action.id);
        const list = panoramaRows.tunables(ev.action.id);
        if (!inst || list.length < 2) return this.showBadge(ev.action.id);
        inst.fn = (inst.fn + 1) % list.length;
        this.showBadge(ev.action.id);
    }

    private applyTicks(id: string): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.tuneTimer = undefined;
        const ticks = inst.pendingTicks;
        inst.pendingTicks = 0;
        const fn = panoramaRows.tunables(id)[inst.fn];
        if (fn && ticks) panoramaRows.tune(id, fn.key, ticks);
        void this.renderDial(id);
    }

    private showBadge(id: string): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.badgeUntil = Date.now() + BADGE_MS;
        void this.renderDial(id);
        // Redraw while it fades and once it's gone (the effect redraws too, but may be paused)
        for (const ms of [BADGE_MS - BADGE_FADE_MS / 2, BADGE_MS + 20]) setTimeout(() => void this.renderDial(id), ms);
    }

    /** The function badge at the top: icon, name and how far the value is turned. */
    private badge(id: string): string {
        const inst = this.instances.get(id);
        const left = (inst?.badgeUntil ?? 0) - Date.now();
        if (!inst || left <= 0) return "";
        const list = panoramaRows.tunables(id);
        const fn = list[inst.fn % Math.max(1, list.length)];
        if (!fn) return "";
        const opacity = left < BADGE_FADE_MS ? left / BADGE_FADE_MS : 1;
        const name = piT(fn.label);
        const textW = measureArialWidth(name, 12, true);
        const barW = 44;
        const w = 8 + 16 + 6 + textW + 8 + barW + 10;
        const x = 100 - w / 2;
        const level = (fn.value - fn.min) / Math.max(1e-9, fn.max - fn.min);
        const bx = x + 30 + textW + 8;
        const icon = CONTROL_ICONS[fn.control ?? ""] ?? mdiSpeedometer;
        return [
            `<g opacity="${opacity.toFixed(2)}">`,
            `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="22" rx="8" fill="#000" opacity="0.7"/>`,
            `<path transform="translate(${(x + 8).toFixed(1)} 3) scale(${16 / 24})" fill="${ACCENT_COLOR}" d="${icon}"/>`,
            `<text x="${(x + 30).toFixed(1)}" y="15.5" fill="#ffffff" font-family="Arial,sans-serif" font-size="12" font-weight="bold">${escapeXml(name)}</text>`,
            `<rect x="${bx.toFixed(1)}" y="9" width="${barW}" height="4" rx="2" fill="#3a3a40"/>`,
            `<rect x="${bx.toFixed(1)}" y="9" width="${Math.max(4, barW * level).toFixed(1)}" height="4" rx="2" fill="${ACCENT_COLOR}"/>`,
            "</g>",
        ].join("");
    }

    // ---- the player: track text ---------------------------------------------------------------

    /** The player this dial's text is about: its choice, the speaker of an older version, or the active player. */
    private playerOf(id: string) {
        const s = this.instances.get(id)?.settings;
        const choice = s?.player || (s?.deviceIp ? `${SONOS_IP_PREFIX}${s.deviceIp}` : undefined);
        return deckPlayers.resolve(choice);
    }

    /** What this dial shows as text, given to the run: it spans the dials of every plugin next to it. */
    private publishText(id: string): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        const p = inst.settings.showTrackInfo ? this.playerOf(id) : undefined;
        const text: RunText | undefined = p?.title ? { kind: "track", title: p.title, artist: p.artist ?? "" } : undefined;
        if (text?.kind === "track" && text.title !== this.lastTitle.get(id)) {
            this.lastTitle.set(id, text.title);
            streamDeck.logger.info(`[Panorama ${id.slice(0, 6)}] text "${text.title}" from ${p?.name ?? "?"} (${p?.source ?? "?"})`);
        }
        textRuns.setText(id, text);
    }

    // ---- drawing ------------------------------------------------------------------------------

    private async renderDial(id: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(id);
        const inst = this.instances.get(id);
        if (!sdAction || !sdAction.isDial() || !inst) return;

        // The run's text (the leftmost dial that shows any, of whichever plugin) is drawn across all
        // its dials; every display cuts its own window of it, so the string is the same on each
        const view = textRuns.run(id);
        const run = view ? { width: view.width, offset: view.offset } : undefined;
        const overlay = view && run ? this.textOverlay.render(view.key, run, view.text, Date.now(), view.at) : "";

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs>',
            '<rect width="200" height="100" fill="#000"/>',
            `<g clip-path="url(#c)">${panorama.renderSlice(id)}</g>`,
            `<g clip-path="url(#c)">${overlay}</g>`,
            this.badge(id),
            "</svg>",
        ].join("");
        const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
        if (image === this.lastImage.get(id)) return;
        this.lastImage.set(id, image);
        const fn = panoramaRows.tunables(id)[inst.fn];
        const indicator = fn ? Math.round(((fn.value - fn.min) / Math.max(1e-9, fn.max - fn.min)) * 100) : 0;
        await sdAction.setFeedback({ "full-canvas": image, "icon": "", "title": "", "indicator": { value: indicator } }).catch(() => {});
    }
}
