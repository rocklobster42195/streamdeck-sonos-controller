import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TrackInfo } from './SonosTypes';

// The @svrooij/sonos library subscribes to REAL GENA events the first time a listener is
// attached to a service's/device's .Events emitter, unless this is set — see
// node_modules/@svrooij/sonos/lib/services/base-service.js. Must be set before
// initializeSubscriptions() (or anything touching .Events) runs.
process.env.SONOS_DISABLE_EVENTS = 'true';

// ./sonos-discovery has a module-load-time side effect (real SSDP discovery) — must be mocked
// before SonosDeviceController is imported anywhere (it imports sonosManager/noteReachableDeviceIp).
vi.mock('./sonos-discovery', () => ({
    sonosManager: { Devices: [] as unknown[] },
    noteReachableDeviceIp: vi.fn(),
}));
vi.mock('./cover-art-loader', () => ({
    loadImageFromUri: vi.fn(async () => ''),
}));
vi.mock('./SonosBattery', () => ({
    fetchBatteryStatus: vi.fn(async () => undefined),
}));
vi.mock('./SonosDeviceManager', () => ({
    sonosDeviceManager: {
        getController: vi.fn(),
        releaseController: vi.fn(),
        peekController: vi.fn(),
    },
}));

import { sonosManager } from './sonos-discovery';
import { sonosDeviceManager } from './SonosDeviceManager';
import { SonosDeviceController } from './SonosDeviceController';

type FakeCoordinatorController = {
    deviceIp: string;
    registerTransportStateCallback: ReturnType<typeof vi.fn>;
    unregisterTransportStateCallback: ReturnType<typeof vi.fn>;
    registerTrackInfoCallback: ReturnType<typeof vi.fn>;
    unregisterTrackInfoCallback: ReturnType<typeof vi.fn>;
    _callbacks: {
        transportState?: (ts: string) => void;
        trackInfo?: (ti: TrackInfo) => void;
    };
};

function createFakeCoordinatorController(deviceIp: string): FakeCoordinatorController {
    const callbacks: FakeCoordinatorController['_callbacks'] = {};
    return {
        deviceIp,
        registerTransportStateCallback: vi.fn((_id: string, cb: (ts: string) => void) => { callbacks.transportState = cb; }),
        unregisterTransportStateCallback: vi.fn(),
        registerTrackInfoCallback: vi.fn((_id: string, cb: (ti: TrackInfo) => void) => { callbacks.trackInfo = cb; }),
        unregisterTrackInfoCallback: vi.fn(),
        _callbacks: callbacks,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

describe('SonosDeviceController', () => {
    beforeEach(() => {
        vi.mocked(sonosDeviceManager.getController).mockReset();
        vi.mocked(sonosDeviceManager.releaseController).mockClear();
        (sonosManager as unknown as { Devices: unknown[] }).Devices = [];
    });

    describe('notePollFailure / notePollSuccess reachability transitions', () => {
        it('fires only on the actual transition, not on every failure/success', () => {
            const controller = new SonosDeviceController('1.2.3.4');
            const events: boolean[] = [];
            controller.registerReachabilityCallback('listener', (r) => events.push(r));
            expect(events).toEqual([]); // starts reachable — no immediate fire

            (controller as unknown as { notePollFailure(): void }).notePollFailure(); // 1 of 2 — below threshold
            expect(events).toEqual([]);
            (controller as unknown as { notePollFailure(): void }).notePollFailure(); // 2 of 2 — flips
            expect(events).toEqual([false]);
            (controller as unknown as { notePollFailure(): void }).notePollFailure(); // already unreachable
            expect(events).toEqual([false]);

            (controller as unknown as { notePollSuccess(): void }).notePollSuccess(); // flips back
            expect(events).toEqual([false, true]);
            (controller as unknown as { notePollSuccess(): void }).notePollSuccess(); // already reachable
            expect(events).toEqual([false, true]);
        });
    });

    describe('late-registering callbacks catch up with cached state', () => {
        it('reachability callback fires immediately when the device is already unreachable', () => {
            const controller = new SonosDeviceController('1.2.3.4');
            (controller as unknown as { notePollFailure(): void }).notePollFailure();
            (controller as unknown as { notePollFailure(): void }).notePollFailure();

            const spy = vi.fn();
            controller.registerReachabilityCallback('late', spy);
            expect(spy).toHaveBeenCalledWith(false);
        });

        it('trackInfo callback fires immediately with the cached track', () => {
            const controller = new SonosDeviceController('1.2.3.4');
            const cachedTrack = { Title: 'Cached Song' } as TrackInfo;
            (controller as unknown as { currentTrack?: TrackInfo }).currentTrack = cachedTrack;

            const spy = vi.fn();
            controller.registerTrackInfoCallback('late', spy);
            expect(spy).toHaveBeenCalledWith(cachedTrack);
        });
    });

    describe('coverFetchAttempts reset gating', () => {
        it('resets only when the track genuinely changes, not on a duplicate currentTrack fire', async () => {
            const controller = new SonosDeviceController('1.2.3.4');
            // The "no art" branch fires a fire-and-forget getCurrentTrackCover() call ONLY when
            // trackChanged — make it fail fast and silently instead of attempting a real request.
            vi.spyOn(controller.sonosDevice.AVTransportService, 'GetPositionInfo').mockRejectedValue(new Error('no network in test'));
            await controller.initializeSubscriptions();

            const state = controller as unknown as { coverFetchAttempts: number; currentTrack?: TrackInfo };
            state.coverFetchAttempts = 3;
            state.currentTrack = { Title: 'Song A' } as TrackInfo;

            controller.sonosDevice.Events.emit('currentTrack', { Title: 'Song A', TrackUri: 'x-file-cifs://a' });
            expect(state.coverFetchAttempts).toBe(3); // duplicate fire for the SAME track — not reset

            controller.sonosDevice.Events.emit('currentTrack', { Title: 'Song B', TrackUri: 'x-file-cifs://b' });
            expect(state.coverFetchAttempts).toBe(0); // genuine track change — reset

            // Let the fire-and-forget getCurrentTrackCover().catch() settle before the test ends.
            await new Promise((r) => setImmediate(r));
        });
    });

    describe('destroy()', () => {
        it('clears every callback registry and releases the coordinator controller exactly once', async () => {
            const controller = new SonosDeviceController('1.2.3.4');
            controller.registerVolumeCallback('a', () => {});
            controller.registerFadeStateCallback('a', () => {});
            controller.registerTransportStateCallback('a', () => {});
            controller.registerPlayModeCallback('a', () => {});
            controller.registerTrackInfoCallback('a', () => {});
            controller.registerBatteryCallback('a', () => {}); // starts a poll interval — must be cleared too
            controller.registerReachabilityCallback('a', () => {});

            const fakeCoordinator = createFakeCoordinatorController('COORD-X');
            (controller as unknown as { coordinatorController?: unknown }).coordinatorController = fakeCoordinator;

            controller.destroy();

            expect(controller.debugCallbackCounts()).toBe(
                'volume=0 fade=0 transport=0 playMode=0 trackInfo=0 battery=0 reachability=0'
            );
            expect(fakeCoordinator.unregisterTransportStateCallback).toHaveBeenCalledWith('member-1.2.3.4');
            expect(fakeCoordinator.unregisterTrackInfoCallback).toHaveBeenCalledWith('member-1.2.3.4');
            expect(sonosDeviceManager.releaseController).toHaveBeenCalledWith('COORD-X');

            await new Promise((r) => setImmediate(r)); // let the in-flight battery poll settle
        });
    });

    describe('syncCoordinatorSubscription stale-in-flight guard', () => {
        it('a stale (older) getController resolution does not clobber a newer coordinator switch', async () => {
            const controller = new SonosDeviceController('1.2.3.4');
            const devices = sonosManager as unknown as { Devices: unknown[] };

            const deferredA = deferred<FakeCoordinatorController>();
            const deferredB = deferred<FakeCoordinatorController>();
            vi.mocked(sonosDeviceManager.getController).mockImplementation((host: string) => {
                if (host === 'COORD-A') return deferredA.promise as never;
                if (host === 'COORD-B') return deferredB.promise as never;
                throw new Error(`unexpected host ${host}`);
            });

            const sync = () => (controller as unknown as { syncCoordinatorSubscription(): Promise<void> }).syncCoordinatorSubscription();

            devices.Devices = [{ Host: '1.2.3.4', Coordinator: { Host: 'COORD-A' } }];
            const call1 = sync(); // captures coordinatorHost = 'COORD-A', suspends on getController('COORD-A')

            devices.Devices = [{ Host: '1.2.3.4', Coordinator: { Host: 'COORD-B' } }];
            const call2 = sync(); // captures coordinatorHost = 'COORD-B', suspends on getController('COORD-B')

            const controllerA = createFakeCoordinatorController('COORD-A');
            const controllerB = createFakeCoordinatorController('COORD-B');

            // Newer call resolves FIRST.
            deferredB.resolve(controllerB);
            await call2;
            // Stale call resolves LAST.
            deferredA.resolve(controllerA);
            await call1;

            expect((controller as unknown as { coordinatorController?: unknown }).coordinatorController).toBe(controllerB);
            expect(controllerB.registerTransportStateCallback).toHaveBeenCalled();
            expect(controllerA.registerTransportStateCallback).not.toHaveBeenCalled();
            expect(sonosDeviceManager.releaseController).toHaveBeenCalledWith('COORD-A');
            expect(sonosDeviceManager.releaseController).not.toHaveBeenCalledWith('COORD-B');
        });
    });

    describe('forwarded coordinator track-info dedupe', () => {
        it('dedupes on Title+cover equality, and forwards again once either actually changes', async () => {
            const controller = new SonosDeviceController('1.2.3.4');
            const devices = sonosManager as unknown as { Devices: unknown[] };
            devices.Devices = [{ Host: '1.2.3.4', Coordinator: { Host: 'COORD-X' } }];

            const fakeCoordinator = createFakeCoordinatorController('COORD-X');
            vi.mocked(sonosDeviceManager.getController).mockResolvedValue(fakeCoordinator as never);

            await (controller as unknown as { syncCoordinatorSubscription(): Promise<void> }).syncCoordinatorSubscription();

            const spy = vi.fn();
            controller.registerTrackInfoCallback('listener', spy);

            fakeCoordinator._callbacks.trackInfo?.({ Title: 'Song A', albumArtDataUri: 'cover1' } as TrackInfo);
            fakeCoordinator._callbacks.trackInfo?.({ Title: 'Song A', albumArtDataUri: 'cover1' } as TrackInfo); // duplicate
            expect(spy).toHaveBeenCalledTimes(1);

            fakeCoordinator._callbacks.trackInfo?.({ Title: 'Song A', albumArtDataUri: 'cover2' } as TrackInfo); // real change
            expect(spy).toHaveBeenCalledTimes(2);
        });
    });
});
