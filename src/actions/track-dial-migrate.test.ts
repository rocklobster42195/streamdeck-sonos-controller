import { describe, expect, it, vi } from "vitest";

vi.mock("./remote-player", () => ({ PLAYER_PREFIX: "player:" }));
const { migrateTrackDial } = await import("./track-dial-migrate");

const known = (ip: string) => (ip === "192.168.1.5" ? "RINCON_A" : undefined);

describe("migrateTrackDial", () => {
    it("a speaker becomes its device, the Equalizer stays, the cover stays on the right; old keys are kept", () => {
        const next = migrateTrackDial({ deviceIp: "192.168.1.5", visualizerMode: "eq", showTrackTitle: false }, known);
        expect(next).toMatchObject({ player: "device:RINCON_A", look: "eq", coverSide: "right", showTitle: false, deviceIp: "192.168.1.5", visualizerMode: "eq" });
    });

    it("an effect mode or 'none' is the info look; an unknown speaker is bound by address", () => {
        expect(migrateTrackDial({ deviceIp: "192.168.1.5", visualizerMode: "none" }, known)?.look).toBe("info");
        expect(migrateTrackDial({ deviceIp: "192.168.1.5", visualizerMode: "particles" }, known)?.look).toBe("info");
        expect(migrateTrackDial({ deviceIp: "10.0.0.9" }, known)).toMatchObject({ player: "sonos-ip:10.0.0.9", look: "eq" });
    });

    it("leaves a migrated, fresh or unconfigured dial alone", () => {
        expect(migrateTrackDial({ player: "device:RINCON_A", deviceIp: "192.168.1.5" }, known)).toBeUndefined();
        expect(migrateTrackDial({}, known)).toBeUndefined();
    });
});
