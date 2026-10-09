import { describe, expect, it, vi } from "vitest";

vi.mock("./remote-player", () => ({ PLAYER_PREFIX: "player:" }));
const { migratePlayPause, migratePlayback } = await import("./play-pause-migrate");

const known = (ip: string) => (ip === "192.168.7.210" ? "RINCON_38420B857BB201400" : undefined);

describe("Play/Pause settings onto the universal key", () => {
    it("a speaker becomes its device; the look stays", () => {
        expect(migratePlayPause({ deviceIp: "192.168.7.210", showTrackTitle: true, showProgress: true, keyColor: "cover", fontSize: 14 }, known)).toEqual({
            player: "device:RINCON_38420B857BB201400",
            keyColor: "cover",
            topLeft: "none",
            topRight: "none",
            battery: "low",
            showCover: true,
            showTitle: true,
            showProgress: true,
            showName: false,
        });
    });

    it("a speaker not found yet keeps its address; another plugin's player keeps its choice", () => {
        expect(migratePlayPause({ deviceIp: "192.168.7.99" }, known)?.player).toBe("sonos-ip:192.168.7.99");
        expect(migratePlayPause({ deviceIp: "player:MA-C/up5c4d4aaf" }, known)?.player).toBe("MA-C/up5c4d4aaf");
        expect(migratePlayPause({ deviceIp: "player:active" }, known)?.player).toBe("active");
    });

    it("a speaker with a battery shows it top right, as before; off stays off; runs once", () => {
        expect(migratePlayPause({ deviceIp: "192.168.7.210", hasBattery: true }, known)).toMatchObject({ topRight: "battery", battery: "low" });
        expect(migratePlayPause({ deviceIp: "192.168.7.210", hasBattery: true, batteryDisplayMode: "full" }, known)).toMatchObject({ topRight: "battery", battery: "always" });
        expect(migratePlayPause({ deviceIp: "192.168.7.210", hasBattery: true, batteryDisplayMode: "off" }, known)?.topRight).toBe("none");
        expect(migratePlayPause({ showCoverArt: false }, known)?.showCover).toBe(false);
        expect(migratePlayPause({ topLeft: "none", topRight: "none" }, known)).toBeUndefined();
    });
});

describe("Playback Control settings onto the universal key", () => {
    it("the speaker becomes its device; command, seek step and colour stay; runs once", () => {
        expect(migratePlayback({ deviceIp: "192.168.7.210", command: "repeat", seekStep: "30", keyColor: "row" }, known)).toEqual({ player: "device:RINCON_38420B857BB201400", command: "repeat", seekStep: "30", keyColor: "row" });
        expect(migratePlayback({ deviceIp: "player:active:all", command: "next" }, known)?.player).toBe("active:all");
        expect(migratePlayback({ player: "active", command: "next" }, known)).toBeUndefined();
    });
});
