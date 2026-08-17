import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VolumeInfo } from './SonosTypes';

// SonosGroupController pulls in ./sonos-discovery, which has a module-load-time side effect
// (real SSDP discovery) — must be mocked before the controller module is imported anywhere.
vi.mock('./sonos-discovery', () => ({
    safeDevices: vi.fn(),
    discoveryPromise: Promise.resolve(),
}));

vi.mock('./SonosDeviceManager', () => ({
    sonosDeviceManager: {
        getController: vi.fn(),
        releaseController: vi.fn(),
    },
}));

import { safeDevices } from './sonos-discovery';
import { sonosDeviceManager } from './SonosDeviceManager';
import { SonosGroupController } from './SonosGroupController';

type FakeDevice = { Host: string; Name: string; Coordinator?: FakeDevice; GroupName?: string };

type FakeController = {
    isReachable: boolean;
    getVolume: ReturnType<typeof vi.fn>;
    setVolume: ReturnType<typeof vi.fn>;
    toggleMute: ReturnType<typeof vi.fn>;
    registerVolumeCallback: ReturnType<typeof vi.fn>;
    unregisterVolumeCallback: ReturnType<typeof vi.fn>;
    registerFadeStateCallback: ReturnType<typeof vi.fn>;
    unregisterFadeStateCallback: ReturnType<typeof vi.fn>;
    registerReachabilityCallback: ReturnType<typeof vi.fn>;
    unregisterReachabilityCallback: ReturnType<typeof vi.fn>;
    sonosDevice: { RenderingControlService: { GetVolume: ReturnType<typeof vi.fn> } };
    _callbacks: {
        volume?: (vi: VolumeInfo) => void;
        fade?: (fading: boolean, durationMs: number) => void;
        reachability?: (reachable: boolean) => void;
    };
};

function createFakeController(initialVolume = 50): FakeController {
    const callbacks: FakeController['_callbacks'] = {};
    return {
        isReachable: true,
        getVolume: vi.fn(async () => ({ volume: initialVolume, mute: false }) as VolumeInfo),
        setVolume: vi.fn(async () => {}),
        toggleMute: vi.fn(async () => true),
        registerVolumeCallback: vi.fn((_id: string, cb: (vi: VolumeInfo) => void) => { callbacks.volume = cb; }),
        unregisterVolumeCallback: vi.fn(),
        registerFadeStateCallback: vi.fn((_id: string, cb: (fading: boolean, durationMs: number) => void) => { callbacks.fade = cb; }),
        unregisterFadeStateCallback: vi.fn(),
        registerReachabilityCallback: vi.fn((_id: string, cb: (reachable: boolean) => void) => { callbacks.reachability = cb; }),
        unregisterReachabilityCallback: vi.fn(),
        sonosDevice: { RenderingControlService: { GetVolume: vi.fn(async () => ({ CurrentVolume: initialVolume })) } },
        _callbacks: callbacks,
    };
}

// Mirrors what a real SonosDeviceController's poll loop does when reachability flips — updates
// the getter AND fires whatever relay callback the group controller registered.
function fireReachability(controller: FakeController, reachable: boolean): void {
    controller.isReachable = reachable;
    controller._callbacks.reachability?.(reachable);
}

describe('SonosGroupController', () => {
    let controllersByHost: Map<string, FakeController>;

    beforeEach(() => {
        vi.useFakeTimers();
        controllersByHost = new Map();
        vi.mocked(sonosDeviceManager.getController).mockImplementation(async (host: string) => {
            let c = controllersByHost.get(host);
            if (!c) { c = createFakeController(); controllersByHost.set(host, c); }
            return c as unknown as import('./SonosDeviceController').SonosDeviceController;
        });
        vi.mocked(sonosDeviceManager.releaseController).mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolveMembers: a topology recheck unregisters+releases a dropped member exactly once and registers a new one, leaving an unchanged member untouched', async () => {
        const deviceA: FakeDevice = { Host: 'A', Name: 'Living Room' };
        const deviceB: FakeDevice = { Host: 'B', Name: 'Kitchen', Coordinator: deviceA, GroupName: 'Party' };
        const deviceC: FakeDevice = { Host: 'C', Name: 'Bedroom', Coordinator: deviceA, GroupName: 'Party' };

        vi.mocked(safeDevices).mockReturnValue([deviceA, deviceB] as never);

        const group = new SonosGroupController('A');
        await group.initialize();

        const controllerA = controllersByHost.get('A')!;
        const controllerB = controllersByHost.get('B')!;
        expect(controllerA.registerVolumeCallback).toHaveBeenCalledTimes(1);
        expect(controllerB.registerVolumeCallback).toHaveBeenCalledTimes(1);

        // Topology changes: B drops out, C joins.
        vi.mocked(safeDevices).mockReturnValue([deviceA, deviceC] as never);
        await vi.advanceTimersByTimeAsync(20000);

        expect(controllerB.unregisterVolumeCallback).toHaveBeenCalledTimes(1);
        expect(controllerB.unregisterFadeStateCallback).toHaveBeenCalledTimes(1);
        expect(controllerB.unregisterReachabilityCallback).toHaveBeenCalledTimes(1);
        expect(sonosDeviceManager.releaseController).toHaveBeenCalledWith('B');
        expect(sonosDeviceManager.releaseController).toHaveBeenCalledTimes(1);

        const controllerC = controllersByHost.get('C')!;
        expect(controllerC.registerVolumeCallback).toHaveBeenCalledTimes(1);

        // A was already a member and stays one — no duplicate registration.
        expect(controllerA.registerVolumeCallback).toHaveBeenCalledTimes(1);
    });

    it('dedupes the group fade-aggregate callback so a same-tick false/false/false sequence never flickers back to true', async () => {
        const deviceA: FakeDevice = { Host: 'A', Name: 'A' };
        const deviceB: FakeDevice = { Host: 'B', Name: 'B', Coordinator: deviceA };
        const deviceC: FakeDevice = { Host: 'C', Name: 'C', Coordinator: deviceA };
        vi.mocked(safeDevices).mockReturnValue([deviceA, deviceB, deviceC] as never);

        const group = new SonosGroupController('A');
        await group.initialize();

        const fadeEvents: boolean[] = [];
        group.registerFadeStateCallback('listener', (fading) => fadeEvents.push(fading));

        const [ca, cb, cc] = ['A', 'B', 'C'].map((h) => controllersByHost.get(h)!);

        // All three start fading — first true flips the aggregate.
        ca._callbacks.fade?.(true, 2000);
        cb._callbacks.fade?.(true, 2000);
        cc._callbacks.fade?.(true, 2000);
        expect(fadeEvents).toEqual([true]);

        // All three finish in the same synchronous pass — aggregate must go true->false exactly
        // once, never flickering back to true in between (member 2/3 are still momentarily true).
        ca._callbacks.fade?.(false, 0);
        cb._callbacks.fade?.(false, 0);
        cc._callbacks.fade?.(false, 0);
        expect(fadeEvents).toEqual([true, false]);
    });

    it('MEMBER_FEEDBACK_SUPPRESS_MS: ignores an echoed volume while suppressed, applies it once the window lapses, and adjustVolume then reads the live baseline', async () => {
        const deviceA: FakeDevice = { Host: 'A', Name: 'A' };
        vi.mocked(safeDevices).mockReturnValue([deviceA] as never);

        const group = new SonosGroupController('A');
        await group.initialize();
        const controllerA = controllersByHost.get('A')!;

        await group.adjustVolume(10); // 50 -> 60, starts the suppression window
        expect(controllerA.setVolume).toHaveBeenCalledWith(60);
        expect((await group.getVolume()).volume).toBe(60);

        // Echo arrives WHILE suppressed — must be ignored.
        controllerA._callbacks.volume?.({ volume: 55, mute: false });
        expect((await group.getVolume()).volume).toBe(60);

        // Once the suppression window lapses, a real echo is applied.
        await vi.advanceTimersByTimeAsync(801);
        controllerA._callbacks.volume?.({ volume: 55, mute: false });
        expect((await group.getVolume()).volume).toBe(55);

        // A later adjustVolume, now that suppression has lapsed, must read the LIVE device value
        // (70) as its baseline rather than the stale optimistic cache (55).
        controllerA.sonosDevice.RenderingControlService.GetVolume.mockResolvedValueOnce({ CurrentVolume: 70 });
        await group.adjustVolume(5);
        expect(controllerA.setVolume).toHaveBeenCalledWith(75);
    });

    it('adjustVolume clamps at the 100 boundary and skips setVolume entirely when the delta is a no-op', async () => {
        const deviceA: FakeDevice = { Host: 'A', Name: 'A' };
        const deviceB: FakeDevice = { Host: 'B', Name: 'B', Coordinator: deviceA };
        vi.mocked(safeDevices).mockReturnValue([deviceA, deviceB] as never);

        const group = new SonosGroupController('A');
        await group.initialize();
        const controllerA = controllersByHost.get('A')!;
        const controllerB = controllersByHost.get('B')!;

        controllerA.sonosDevice.RenderingControlService.GetVolume.mockResolvedValue({ CurrentVolume: 98 });
        controllerB.sonosDevice.RenderingControlService.GetVolume.mockResolvedValue({ CurrentVolume: 100 });

        await group.adjustVolume(10);

        expect(controllerA.setVolume).toHaveBeenCalledWith(100); // clamped, not 108
        expect(controllerB.setVolume).not.toHaveBeenCalled(); // already at 100 — no-op skip
    });

    it('only relays the ANCHOR member\'s reachability, and a late registration gets the current state immediately', async () => {
        const deviceA: FakeDevice = { Host: 'A', Name: 'A' };
        const deviceB: FakeDevice = { Host: 'B', Name: 'B', Coordinator: deviceA };
        vi.mocked(safeDevices).mockReturnValue([deviceA, deviceB] as never);

        const group = new SonosGroupController('A');
        await group.initialize();
        const controllerA = controllersByHost.get('A')!;
        const controllerB = controllersByHost.get('B')!;

        // Only the anchor (A) gets a reachability relay registered — B never does.
        expect(controllerA.registerReachabilityCallback).toHaveBeenCalledTimes(1);
        expect(controllerB.registerReachabilityCallback).not.toHaveBeenCalled();

        fireReachability(controllerA, false);

        const lateSpy = vi.fn();
        group.registerReachabilityCallback('late-listener', lateSpy);
        expect(lateSpy).toHaveBeenCalledWith(false);
    });
});
