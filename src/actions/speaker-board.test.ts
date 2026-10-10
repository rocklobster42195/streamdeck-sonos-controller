import { describe, expect, it, vi } from "vitest";

vi.mock("../sonos/sonos-discovery", () => ({
    safeDevices: () => [
        { Uuid: "RINCON_K", Host: "10.0.0.2", Name: "Küche" },
        { Uuid: "RINCON_H", Host: "10.0.0.1", Name: "Herrenzimmer" },
    ],
}));
vi.mock("./play-pause-migrate", () => ({ SONOS_IP_PREFIX: "sonos-ip:" }));
const group = { id: "device:RINCON_H", player: "RINCON_H", name: "Herrenzimmer + 5", volume: 30, muted: false, can: ["volume", "mute"] };
const sent: unknown[][] = [];
vi.mock("./deck-players", () => ({
    deckPlayers: {
        resolve: (choice?: string) => (choice === "device:RINCON_K" || choice === "device:RINCON_H" ? group : undefined),
        send: async (...args: unknown[]) => void sent.push(args),
        onChange: () => () => {},
    },
}));

const { speakerBoard, holdSpeaker, dropSpeaker, speakerIpOf } = await import("./speaker-board");

function fakeController() {
    const calls: [string, unknown][] = [];
    return {
        calls,
        deviceIp: "10.0.0.2",
        liveVolume: 12,
        liveMuted: false,
        setVolume: async (v: number) => void calls.push(["volume", v]),
        setMute: async (m: boolean) => void calls.push(["mute", m]),
    };
}

describe("speakerBoard", () => {
    it("finds a speaker's address by its device or an address choice", () => {
        expect(speakerIpOf("device:RINCON_K")).toBe("10.0.0.2");
        expect(speakerIpOf("sonos-ip:10.0.0.9")).toBe("10.0.0.9");
        expect(speakerIpOf("active")).toBeUndefined();
    });

    it("a held speaker shows its own name and volume and sets only itself, though it plays in a group", async () => {
        const c = fakeController();
        holdSpeaker("device:RINCON_K", c as never);
        const p = speakerBoard.resolve("device:RINCON_K")!;
        expect(p).toMatchObject({ name: "Küche", volume: 12, muted: false });
        await speakerBoard.send(p, "volume", 17);
        await speakerBoard.send(p, "volume-by", -5);
        await speakerBoard.send(p, "mute", true);
        expect(c.calls).toEqual([["volume", 17], ["volume", 7], ["mute", true]]);
        expect(sent).toEqual([]);
        dropSpeaker("device:RINCON_K", c as never);
        expect(speakerBoard.resolve("device:RINCON_K")).toMatchObject({ name: "Herrenzimmer + 5" });
    });

    it("another plugin's player or the active one goes through the deck's board", async () => {
        await speakerBoard.send({ id: "ma/x" } as never, "volume", 20);
        expect(sent).toEqual([[{ id: "ma/x" }, "volume", 20]]);
    });
});
