import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { FALLBACK_BASE, canListen, pickListenerPort, type Probe } from "./listener-port";

describe("pickListenerPort", () => {
    it("keeps the wanted port when it is free", async () => {
        const probe: Probe = async () => ({ ok: true });
        expect(await pickListenerPort(6329, probe)).toEqual({ port: 6329, skipped: [] });
    });

    it("takes the first free port of the fixed ladder when Windows has reserved the wanted one", async () => {
        const probe: Probe = async (port) => (port === 6329 ? { ok: false, code: "EACCES" } : { ok: true });
        expect(await pickListenerPort(6329, probe)).toEqual({ port: FALLBACK_BASE, skipped: [{ port: 6329, code: "EACCES" }] });
    });

    it("skips ladder ports that are taken too, and gives up when none is free", async () => {
        const taken = new Set([6329, FALLBACK_BASE, FALLBACK_BASE + 1]);
        const probe: Probe = async (port) => (taken.has(port) ? { ok: false, code: port === 6329 ? "EACCES" : "EADDRINUSE" } : { ok: true });
        const picked = await pickListenerPort(6329, probe);
        expect(picked?.port).toBe(FALLBACK_BASE + 2);
        expect(picked?.skipped.map((s) => s.code)).toEqual(["EACCES", "EADDRINUSE", "EADDRINUSE"]);
        expect(await pickListenerPort(6329, async () => ({ ok: false, code: "EACCES" }))).toBeUndefined();
    });
});

describe("canListen", () => {
    it("says yes for a free port and EADDRINUSE for one a program holds", async () => {
        const holder = createServer();
        const port = await new Promise<number>((ok) => holder.listen(0, () => ok((holder.address() as { port: number }).port)));
        try {
            expect(await canListen(port)).toEqual({ ok: false, code: "EADDRINUSE" });
        } finally {
            await new Promise((ok) => holder.close(ok));
        }
        expect(await canListen(port)).toEqual({ ok: true });
    });
});
