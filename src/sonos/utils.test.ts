import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateFaderSvg, loadImageFromUri } from './utils';
import { SonosDevice } from '@svrooij/sonos';

function decodeSvg(dataUri: string): string {
  const base64 = dataUri.replace('data:image/svg+xml;base64,', '');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function fakeDevice(host: string): SonosDevice {
  return { Host: host, Port: 1400 } as SonosDevice;
}

function jpegResponse(byte: number): Response {
  return new Response(new Uint8Array([byte]), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
}

describe('generateFaderSvg', () => {
  it('renders the mute icon when isMuted is true, regardless of level', () => {
    const svg = decodeSvg(generateFaderSvg(50, true, '#fff'));
    expect(svg).toContain('M12,4L9.91,6.09L12,8.18');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('renders a full inner circle at 100%', () => {
    const svg = decodeSvg(generateFaderSvg(100, false, '#fff'));
    expect(svg).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
  });

  it('renders no pie slice at 0%', () => {
    const svg = decodeSvg(generateFaderSvg(0, false, '#fff'));
    expect(svg).not.toContain('<path d="M 12 12');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('clamps levels above 100 and below 0', () => {
    const over = decodeSvg(generateFaderSvg(150, false, '#fff'));
    const under = decodeSvg(generateFaderSvg(-20, false, '#fff'));
    expect(over).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
    expect(under).not.toContain('<path d="M 12 12');
  });

  it('uses the large-arc-flag once the slice passes 180 degrees', () => {
    const svg = decodeSvg(generateFaderSvg(75, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 1 1/);
  });

  it('does not use the large-arc-flag below 180 degrees', () => {
    const svg = decodeSvg(generateFaderSvg(25, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 0 1/);
  });

  it('always draws the outer ring', () => {
    const svg = decodeSvg(generateFaderSvg(42, false, '#abc'));
    expect(svg).toContain('<circle cx="12" cy="12" r="9" stroke="#abc" stroke-width="1.5" fill="none"/>');
  });
});

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
