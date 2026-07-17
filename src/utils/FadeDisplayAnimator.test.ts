import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FadeDisplayAnimator } from './FadeDisplayAnimator';

describe('FadeDisplayAnimator', () => {
  let render: ReturnType<typeof vi.fn<() => void>>;
  let anim: FadeDisplayAnimator;

  beforeEach(() => {
    vi.useFakeTimers();
    render = vi.fn<() => void>();
    anim = new FadeDisplayAnimator(render);
  });

  afterEach(() => {
    anim.stop();
    vi.useRealTimers();
  });

  it('initialize snaps target and display with no animation', () => {
    anim.initialize(42);
    expect(anim.targetVolume).toBe(42);
    expect(anim.current()).toBe(42);
    vi.advanceTimersByTime(200);
    expect(render).not.toHaveBeenCalled();
  });

  it('setTarget without ease snaps instantly (single-detent turn)', () => {
    anim.initialize(30);
    anim.setTarget(31, false);
    expect(anim.current()).toBe(31);
    expect(render).not.toHaveBeenCalled();
  });

  it('setTarget with ease glides toward the target and self-stops', () => {
    anim.initialize(20);
    anim.setTarget(60, true);
    expect(anim.current()).toBe(20); // nothing moves until the first tick
    vi.advanceTimersByTime(25);
    const afterOneTick = anim.current();
    expect(afterOneTick).toBeGreaterThan(20);
    expect(afterOneTick).toBeLessThan(60);
    vi.advanceTimersByTime(2000);
    expect(anim.current()).toBe(60);
    const rendersWhenSettled = render.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(render.mock.calls.length).toBe(rendersWhenSettled); // timer stopped itself
  });

  it('onEcho eases toward the echoed value when not fading', () => {
    anim.initialize(10);
    anim.onEcho(50);
    expect(anim.targetVolume).toBe(50);
    vi.advanceTimersByTime(2000);
    expect(anim.current()).toBe(50);
  });

  it('fades down over the given duration, then glides back to the restored volume', () => {
    anim.initialize(80);
    anim.onFadeState(true, 1000);
    expect(anim.isFading).toBe(true);
    expect(anim.current()).toBeCloseTo(80, 5);

    vi.advanceTimersByTime(500);
    expect(anim.current()).toBeCloseTo(40, 0); // halfway down

    vi.advanceTimersByTime(500);
    expect(anim.current()).toBeCloseTo(0, 0); // fully faded

    // Restore signal: target already back at pre-fade level (the controller restores volumes).
    anim.onEcho(80); // ignored while fading (no anim start)
    anim.onFadeState(false, 0);
    expect(anim.isFading).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(anim.current()).toBe(80);
  });

  it('a second fade starts from the real current value, not a stale computed one', () => {
    anim.initialize(80);
    anim.onFadeState(true, 1000);
    vi.advanceTimersByTime(1100);
    anim.onFadeState(false, 0);
    vi.advanceTimersByTime(2000); // glide back up (target still 80)
    expect(anim.current()).toBe(80);

    // Second fade must descend from 80 again — the historical bug started it from 0.
    anim.onFadeState(true, 1000);
    expect(anim.current()).toBeCloseTo(80, 0);
    vi.advanceTimersByTime(500);
    expect(anim.current()).toBeCloseTo(40, 0);
  });

  it('echoes during a fade update the target but never repaint mid-descent', () => {
    anim.initialize(80);
    anim.onFadeState(true, 1000);
    render.mockClear();
    anim.onEcho(53); // a coarse real fade step arriving from the device
    expect(anim.targetVolume).toBe(53);
    // current() still follows the smooth computed descent, not the echo.
    vi.advanceTimersByTime(500);
    expect(anim.current()).toBeCloseTo(40, 0);
  });
});
