import { describe, expect, it, vi } from "vitest";

vi.mock("./remote-player", () => ({ PLAYER_PREFIX: "player:" }));
const { migrateVolumeDial } = await import("./volume-dial-migrate");

const known = (ip: string) => (ip === "192.168.1.5" ? "RINCON_A" : undefined);

describe("migrateVolumeDial", () => {
    it("a speaker becomes its device; preset, pie and one percent per tick stay; old keys are kept", () => {
        const next = migrateVolumeDial({ deviceIp: "192.168.1.5", presetVolume: 35, align: "right", showText: true }, known);
        expect(next).toMatchObject({ player: "device:RINCON_A", preset: 35, gauge: "pie", step: 1, deviceIp: "192.168.1.5", presetVolume: 35, align: "right" });
    });

    it("a speaker discovery doesn't know yet is bound by address; a set preset-less dial gets the old default 50", () => {
        const next = migrateVolumeDial({ deviceIp: "10.0.0.9" }, known);
        expect(next).toMatchObject({ player: "sonos-ip:10.0.0.9", preset: 50 });
    });

    it("leaves a migrated, a fresh or an unconfigured dial alone, and keeps a chosen look", () => {
        expect(migrateVolumeDial({ player: "device:RINCON_A", deviceIp: "192.168.1.5" }, known)).toBeUndefined();
        expect(migrateVolumeDial({}, known)).toBeUndefined();
        expect(migrateVolumeDial({ deviceIp: "192.168.1.5", gauge: "open", step: 3 }, known)).toMatchObject({ gauge: "open", step: 3 });
    });
});
