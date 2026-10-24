import { createServer } from "node:net";

// The port the speakers send their UPnP events to (the PC listens on it). The library listens on 6329
// without any error handling, so a port Windows has reserved for something else (Hyper-V, WSL or Docker
// reserve ranges that change with every reboot, `netsh interface ipv4 show excludedportrange
// protocol=tcp`) ends in "listen EACCES" as an uncaught exception, and no event ever arrives.
// Instead the port is tried first, and a fixed ladder of ports in the dynamic range comes after it:
// the same ones every time, so a firewall rule can name them.

export type ProbeResult = { ok: true } | { ok: false; code: string };
export type Probe = (port: number) => Promise<ProbeResult>;

/** The first port of the fallback ladder (the dynamic range starts at 49152). */
export const FALLBACK_BASE = 52329;
const LADDER = 20;

/** Can this process listen on `port` on all addresses? EACCES: reserved by Windows; EADDRINUSE: taken. */
export const canListen: Probe = (port) =>
    new Promise((resolve) => {
        const server = createServer();
        server.once("error", (e: NodeJS.ErrnoException) => resolve({ ok: false, code: e.code ?? "unknown" }));
        server.listen(port, () => server.close(() => resolve({ ok: true })));
    });

/** The first port that works: `wanted`, then the ladder; `skipped` says why the earlier ones did not. */
export async function pickListenerPort(wanted: number, probe: Probe = canListen): Promise<{ port: number; skipped: { port: number; code: string }[] } | undefined> {
    const skipped: { port: number; code: string }[] = [];
    for (const port of [wanted, ...Array.from({ length: LADDER }, (_, i) => FALLBACK_BASE + i)]) {
        const result = await probe(port);
        if (result.ok) return { port, skipped };
        skipped.push({ port, code: result.code });
    }
    return undefined;
}
