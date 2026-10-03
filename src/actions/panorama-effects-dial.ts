import { type JsonValue } from "@elgato/utils";
import streamDeck, {
    action,
    DialDownEvent,
    DialRotateEvent,
    DidReceiveSettingsEvent,
    SendToPluginEvent,
    SingletonAction,
    WillAppearEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { effectRegistry, measureArialWidth, truncateToWidth } from "@rocklobster42195/streamdeck-kit";
import { panorama, panoramaRows, socRowState } from "../effects/panorama";
import { sonosDeviceManager } from "../sonos/SonosDeviceManager";
import { SonosDeviceController } from "../sonos/SonosDeviceController";
import { TrackInfo } from "../sonos/SonosTypes";
import { ControllerLease } from "./ControllerLease";
import { getDominantColor, ensureVisibleColor } from "../utils/color-extract";
import { escapeXml } from "../utils/xml";
import { piT } from "../utils/pi-i18n";
import { sendDeviceList, sendOptions } from "./pi-options";

type PanoramaEffectsSettings = {
    // The old per-dial effect choice — taken over into the row once (socRowState), then the row's.
    effectId?: string;
    // The speaker whose cover tints the effect and whose track the text shows.
    deviceIp?: string;
    // Colour without a speaker.
    staticColor?: string;
    showTrackInfo?: boolean;
    [key: string]: JsonValue | undefined;
};

type Instance = { settings: PanoramaEffectsSettings; deviceId: string; column: number; track?: { title: string; artist: string }; color?: string; colorFor?: string };

const PERSIST_MS = 800;

/**
 * The "Panorama Effects" dial: the row's effect (the kit's Panorama, one effect per row of dials)
 * with nothing else on it — or, with "Show track info", title and artist of its speaker across the
 * Panorama Effects dials next to each other. Rotate tunes the effect (speed, density, …), press
 * switches what turning changes; the values become the row's. Tinted with the speaker's cover
 * colour, or the static colour without a speaker.
 */
@action({ UUID: "de.boriskemper.sonos-controller.panorama-effects-dial" })
export class PanoramaEffectsDial extends SingletonAction<PanoramaEffectsSettings> {
    private readonly instances = new Map<string, Instance>();
    private readonly persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly lastImage = new Map<string, string>();
    private lease = new ControllerLease<SonosDeviceController>(
        (ip) => sonosDeviceManager.getController(ip),
        (controller) => sonosDeviceManager.releaseController(controller.deviceIp),
    );

    override async onWillAppear(ev: WillAppearEvent<PanoramaEffectsSettings>): Promise<void> {
        if (!ev.action.isDial()) return;
        const id = ev.action.id;
        const column = "coordinates" in ev.payload && ev.payload.coordinates ? ev.payload.coordinates.column : 0;
        this.instances.set(id, { settings: ev.payload.settings, deviceId: ev.action.device.id, column });
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
        await this.followDevice(id);
        this.pushLive(id);
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PanoramaEffectsSettings>): Promise<void> {
        const inst = this.instances.get(ev.action.id);
        if (!inst) return;
        const before = inst.settings;
        inst.settings = ev.payload.settings;
        panoramaRows.changed(ev.action.id);
        if (before.deviceIp !== inst.settings.deviceIp) await this.followDevice(ev.action.id);
        this.pushLive(ev.action.id);
        void this.renderDial(ev.action.id);
    }

    override async onWillDisappear(ev: WillDisappearEvent<PanoramaEffectsSettings>): Promise<void> {
        const id = ev.action.id;
        clearTimeout(this.persistTimers.get(id));
        this.persistTimers.delete(id);
        this.lease.release(id);
        this.instances.delete(id);
        this.lastImage.delete(id);
        panoramaRows.remove(id);
    }

    override async onDialRotate(ev: DialRotateEvent<PanoramaEffectsSettings>): Promise<void> {
        panorama.rotate(ev.action.id, ev.payload.ticks);
        this.persistRuntime(ev.action.id);
    }

    // Press switches what turning changes (e.g. particle count and speed)
    override async onDialDown(ev: DialDownEvent<PanoramaEffectsSettings>): Promise<void> {
        panorama.press(ev.action.id);
        this.persistRuntime(ev.action.id);
        void this.renderDial(ev.action.id);
    }

    override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, PanoramaEffectsSettings>): Promise<void> {
        if (typeof ev.payload !== "object" || ev.payload === null || !("event" in ev.payload)) return;
        switch (ev.payload.event) {
            case "get-devices": await sendDeviceList("-- No device (static color) --", (await ev.action.getSettings()).deviceIp); break;
            case "get-effects":
                sendOptions("get-effects", [...effectRegistry.values()].map((def) => ({ label: piT(def.displayName), value: def.id })));
                break;
        }
    }

    // ---- the speaker: track text and cover colour --------------------------------------------

    private async followDevice(id: string): Promise<void> {
        this.lease.release(id);
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.track = undefined;
        inst.color = undefined;
        inst.colorFor = undefined;
        const ip = inst.settings.deviceIp;
        if (!ip) return;
        try {
            await this.lease.acquire(id, ip, (controller) => {
                controller.registerTrackInfoCallback(id, (ti) => this.onTrack(id, ti));
                return [() => controller.unregisterTrackInfoCallback(id)];
            });
        } catch (e) {
            streamDeck.logger.warn(`[Panorama ${id}] speaker ${ip} not available`, e);
        }
    }

    private onTrack(id: string, ti: TrackInfo): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        inst.track = ti.Title ? { title: ti.Title, artist: ti.Artist ?? "" } : undefined;
        const cover = ti.albumArtDataUri;
        if (cover && cover !== inst.colorFor) {
            inst.colorFor = cover;
            getDominantColor(cover).then((c) => {
                const now = this.instances.get(id);
                if (!now) return;
                now.color = ensureVisibleColor(c);
                this.pushLive(id);
            }).catch(() => {});
        }
        this.renderOwnRun(id);
    }

    /** The colour as a live value: it wins over the row's colours (the cover, or the static colour). */
    private pushLive(id: string): void {
        const inst = this.instances.get(id);
        const effect = panoramaRows.effectOf(id);
        if (!inst || !effect) return;
        const color = inst.settings.deviceIp ? inst.color : inst.settings.staticColor;
        if (!color) return panorama.updateLive(id, {});
        const fields = new Set((effectRegistry.get(effect)?.settingsSchema ?? []).map((f) => f.key));
        panorama.updateLive(id, { color, ...(fields.has("primaryColor") ? { primaryColor: color } : {}), ...(fields.has("landColor") ? { landColor: color } : {}) });
    }

    private persistRuntime(id: string): void {
        clearTimeout(this.persistTimers.get(id));
        this.persistTimers.set(id, setTimeout(() => {
            const inst = this.instances.get(id);
            const runtime = panorama.runtimeSettings(id);
            // Turning tunes the row's effect: stored with every dial of the row
            if (inst && runtime) panoramaRows.setRow(inst.deviceId, { settings: runtime });
        }, PERSIST_MS));
    }

    // ---- drawing ------------------------------------------------------------------------------

    /** The Panorama Effects dials right next to each other on this device (this one included). */
    private ownRun(id: string): string[] {
        const me = this.instances.get(id);
        if (!me) return [id];
        const byColumn = new Map<number, string>();
        for (const [other, inst] of this.instances) if (inst.deviceId === me.deviceId) byColumn.set(inst.column, other);
        let left = me.column;
        while (byColumn.has(left - 1)) left--;
        let right = me.column;
        while (byColumn.has(right + 1)) right++;
        const run: string[] = [];
        for (let c = left; c <= right; c++) run.push(byColumn.get(c)!);
        return run;
    }

    private renderOwnRun(id: string): void {
        for (const other of this.ownRun(id)) void this.renderDial(other);
    }

    private async renderDial(id: string): Promise<void> {
        const sdAction = streamDeck.actions.getActionById(id);
        const inst = this.instances.get(id);
        if (!sdAction || !sdAction.isDial() || !inst) return;

        // Title and artist of the run's speaker, right-aligned at the run's last dial; long lines
        // grow left over the run and are cut to it, so every dial cuts the same string
        const run = this.ownRun(id).map((c) => this.instances.get(c)!).filter(Boolean);
        const source = run.find((r) => r.settings.showTrackInfo && r.track);
        const cols = run.map((r) => r.column);
        const anchorX = 196 + (Math.max(...cols) - inst.column) * 200;
        const maxW = 196 + (Math.max(...cols) - Math.min(...cols)) * 200 - 8;
        const title = source?.track?.title ? truncateToWidth(source.track.title, 20, maxW) : "";
        const artist = source?.track?.artist ? truncateToWidth(source.track.artist, 15, maxW) : "";
        const titleW = title ? measureArialWidth(title, 20) : 0;
        const artistW = artist ? measureArialWidth(artist, 15) : 0;
        const text = (x: number, y: number, size: number, color: string, weight: string, value: string) =>
            value ? `<text x="${x}" y="${y}" fill="${color}" font-family="Arial,sans-serif" font-size="${size}"${weight ? ` font-weight="${weight}"` : ""} text-anchor="end" clip-path="url(#c)">${escapeXml(value)}</text>` : "";

        const svg = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
            '<defs><clipPath id="c"><rect width="200" height="100"/></clipPath></defs>',
            '<rect width="200" height="100" fill="#000"/>',
            `<g clip-path="url(#c)">${panorama.renderSlice(id)}</g>`,
            titleW ? `<rect x="${anchorX - titleW - 4}" y="49" width="${titleW + 8}" height="27" rx="3" fill="#000" fill-opacity="0.7" clip-path="url(#c)"/>` : "",
            text(anchorX, 72, 20, "#fff", "500", title),
            artistW ? `<rect x="${anchorX - artistW - 4}" y="77" width="${artistW + 8}" height="20" rx="3" fill="#000" fill-opacity="0.7" clip-path="url(#c)"/>` : "",
            text(anchorX, 93, 15, "#aaa", "", artist),
            "</svg>",
        ].join("");
        const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
        if (image === this.lastImage.get(id)) return;
        this.lastImage.set(id, image);
        await sdAction.setFeedback({ "full-canvas": image, "icon": "", "title": "", "indicator": { value: panorama.indicator(id) ?? 0 } }).catch(() => {});
    }
}
