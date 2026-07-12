// Caps concurrent async work per host key (e.g. a Sonos device's IP). Multiple independent
// subsystems (SonosDeviceController's per-track cover loading, Queue Dial's carousel browsing)
// each fetch images from the same small embedded device over HTTP — without a shared cap they
// compete for the same connection pool instead of the intended "at most a couple in flight at
// once", each starving the other out (confirmed on hardware: fixing one side's fetch pattern kept
// just shifting the same slowness onto the other).
const MAX_CONCURRENT_PER_HOST = 2;

interface HostQueue {
    active: number;
    waiters: (() => void)[];
}

const hostQueues: Map<string, HostQueue> = new Map();

function acquire(host: string): Promise<void> {
    let q = hostQueues.get(host);
    if (!q) { q = { active: 0, waiters: [] }; hostQueues.set(host, q); }
    if (q.active < MAX_CONCURRENT_PER_HOST) {
        q.active++;
        return Promise.resolve();
    }
    return new Promise<void>(resolve => q!.waiters.push(resolve));
}

function release(host: string): void {
    const q = hostQueues.get(host);
    if (!q) return;
    const next = q.waiters.shift();
    if (next) { next(); return; } // slot passes straight to the next waiter — active count unchanged
    q.active = Math.max(0, q.active - 1);
}

export function runThrottled<T>(host: string, fn: () => Promise<T>): Promise<T> {
    return acquire(host).then(() => fn().finally(() => release(host)));
}
