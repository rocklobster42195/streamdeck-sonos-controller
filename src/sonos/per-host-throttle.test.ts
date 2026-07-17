import { describe, it, expect } from 'vitest';
import { runThrottled } from './per-host-throttle';

// Controllable async task: starts running immediately, but only resolves once `release()` is
// called — lets tests observe exactly how many are concurrently "active" at a given point.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

describe('runThrottled', () => {
    it('runs a single task immediately', async () => {
        const result = await runThrottled('host-a', async () => 42);
        expect(result).toBe(42);
    });

    it('caps concurrency at 2 for the same host — a 3rd task waits until a slot frees up', async () => {
        const started: number[] = [];
        const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

        const runs = gates.map((gate, i) =>
            runThrottled('host-b', async () => {
                started.push(i);
                await gate.promise;
                return i;
            })
        );

        // Let the microtask queue settle so the first two tasks have had a chance to start.
        await Promise.resolve().then(() => Promise.resolve());
        expect(started).toEqual([0, 1]); // task 2 is queued, not yet started

        gates[0].resolve();
        await runs[0];
        // Releasing a slot lets the 3rd task start.
        await Promise.resolve().then(() => Promise.resolve());
        expect(started).toEqual([0, 1, 2]);

        gates[1].resolve();
        gates[2].resolve();
        await Promise.all(runs);
    });

    it('does not throttle across different hosts', async () => {
        const started: string[] = [];
        const gates = [deferred<void>(), deferred<void>(), deferred<void>()];

        const runs = ['host-x', 'host-y', 'host-z'].map((host, i) =>
            runThrottled(host, async () => {
                started.push(host);
                await gates[i].promise;
            })
        );

        await Promise.resolve().then(() => Promise.resolve());
        expect(started).toEqual(['host-x', 'host-y', 'host-z']);

        gates.forEach(g => g.resolve());
        await Promise.all(runs);
    });

    it('propagates a rejection without leaking the slot', async () => {
        await expect(runThrottled('host-c', async () => { throw new Error('boom'); }))
            .rejects.toThrow('boom');

        // The slot from the failed task must have been released — this would hang forever
        // (timeout the test) if it wasn't.
        const result = await runThrottled('host-c', async () => 'ok');
        expect(result).toBe('ok');
    });
});
