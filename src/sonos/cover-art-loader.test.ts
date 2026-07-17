import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadImageFromUri } from './cover-art-loader';
import { SonosDevice } from '@svrooij/sonos';

function fakeDevice(host: string): SonosDevice {
  return { Host: host, Port: 1400 } as SonosDevice;
}

function jpegResponse(byte: number): Response {
  return new Response(new Uint8Array([byte]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

describe('loadImageFromUri', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it('fetches and returns a data URI on success', async () => {
    fetchSpy.mockResolvedValue(jpegResponse(1));
    const result = await loadImageFromUri('/art.jpg', fakeDevice('host-basic'));
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches the resolved cover — a repeat request for the same URL never re-fetches', async () => {
    fetchSpy.mockResolvedValue(jpegResponse(2));
    const device = fakeDevice('host-cache');
    const first = await loadImageFromUri('/repeat.jpg', device);
    const second = await loadImageFromUri('/repeat.jpg', device);
    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent requests for the same URL into a single fetch', async () => {
    let resolveGate!: (response: Response) => void;
    const gate = new Promise<Response>(resolve => { resolveGate = resolve; });
    fetchSpy.mockReturnValue(gate);
    const device = fakeDevice('host-concurrent');

    const first = loadImageFromUri('/inflight.jpg', device);
    const second = loadImageFromUri('/inflight.jpg', device);
    resolveGate(jpegResponse(3));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('aborts a stuck fetch after the timeout instead of hanging forever, and releases its throttle slot', async () => {
    vi.useFakeTimers();
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));

    const device = fakeDevice('host-timeout');
    const stuck = loadImageFromUri('/stuck.jpg', device);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(stuck).resolves.toBe('');

    // The timed-out fetch must have released its per-host throttle slot — a follow-up request
    // for a *different* URL on the same host has to actually run, not queue forever behind it.
    fetchSpy.mockResolvedValue(jpegResponse(4));
    const following = await loadImageFromUri('/after-timeout.jpg', device);
    expect(following).toMatch(/^data:image\/jpeg;base64,/);
  });
});
