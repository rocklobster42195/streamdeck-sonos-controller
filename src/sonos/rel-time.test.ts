import { describe, it, expect } from 'vitest';
import { parseRelTime, formatRelTime } from './rel-time';

describe('parseRelTime', () => {
  it('parses H:MM:SS into seconds', () => {
    expect(parseRelTime('0:00:00')).toBe(0);
    expect(parseRelTime('0:03:25')).toBe(205);
    expect(parseRelTime('1:02:03')).toBe(3723);
  });

  it('returns 0 for empty and NOT_IMPLEMENTED', () => {
    expect(parseRelTime('')).toBe(0);
    expect(parseRelTime('NOT_IMPLEMENTED')).toBe(0);
  });

  it('returns 0 for malformed values', () => {
    expect(parseRelTime('3:25')).toBe(0);
    expect(parseRelTime('a:b:c')).toBe(0);
  });
});

describe('formatRelTime', () => {
  it('formats seconds as H:MM:SS', () => {
    expect(formatRelTime(0)).toBe('0:00:00');
    expect(formatRelTime(205)).toBe('0:03:25');
    expect(formatRelTime(3723)).toBe('1:02:03');
  });

  it('floors fractional seconds', () => {
    expect(formatRelTime(59.9)).toBe('0:00:59');
  });

  it('round-trips with parseRelTime', () => {
    for (const s of [0, 1, 59, 60, 61, 3599, 3600, 3661, 7325]) {
      expect(parseRelTime(formatRelTime(s))).toBe(s);
    }
  });
});
