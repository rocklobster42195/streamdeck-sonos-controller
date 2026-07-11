import { describe, it, expect } from 'vitest';
import { normalizeBrowseResult, wrapIndex, truncateForDisplay } from './queueUtils';

describe('normalizeBrowseResult', () => {
  it('returns the array as-is when Result is a Track[]', () => {
    const tracks = [{ Title: 'A' }, { Title: 'B' }];
    expect(normalizeBrowseResult({ Result: tracks, NumberReturned: 2, TotalMatches: 2, UpdateID: 1 })).toBe(tracks);
  });

  it('normalizes a string Result (empty/degenerate queue) to []', () => {
    expect(normalizeBrowseResult({ Result: '', NumberReturned: 0, TotalMatches: 0, UpdateID: 1 })).toEqual([]);
  });
});

describe('wrapIndex', () => {
  it('wraps forward past the end back to the start', () => {
    expect(wrapIndex(4, 1, 5)).toBe(0);
  });

  it('wraps backward past the start to the end', () => {
    expect(wrapIndex(0, -1, 5)).toBe(4);
  });

  it('stays in range for a normal forward step', () => {
    expect(wrapIndex(1, 1, 5)).toBe(2);
  });

  it('handles multi-step deltas larger than the list length', () => {
    expect(wrapIndex(0, 7, 5)).toBe(2);
  });

  it('returns -1 for a zero-length list', () => {
    expect(wrapIndex(0, 1, 0)).toBe(-1);
  });
});

describe('truncateForDisplay', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateForDisplay('Short Title', 20)).toBe('Short Title');
  });

  it('truncates with an ellipsis when too long', () => {
    expect(truncateForDisplay('A Very Long Track Title Indeed', 10)).toBe('A Very Lo…');
  });

  it('handles a maxChars of 1', () => {
    expect(truncateForDisplay('Hello', 1)).toBe('H');
  });
});
