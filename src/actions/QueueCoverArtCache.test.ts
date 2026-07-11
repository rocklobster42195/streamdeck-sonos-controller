import { describe, it, expect } from 'vitest';
import { QueueCoverArtCache } from './QueueCoverArtCache';

describe('QueueCoverArtCache', () => {
  it('returns undefined for a missing key', () => {
    const cache = new QueueCoverArtCache();
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.has('missing')).toBe(false);
  });

  it('stores and retrieves a value', () => {
    const cache = new QueueCoverArtCache();
    cache.set('track1', 'data:image/jpeg;base64,abc');
    expect(cache.get('track1')).toBe('data:image/jpeg;base64,abc');
    expect(cache.has('track1')).toBe(true);
  });

  it('overwrites an existing key without growing size', () => {
    const cache = new QueueCoverArtCache();
    cache.set('track1', 'first');
    cache.set('track1', 'second');
    expect(cache.get('track1')).toBe('second');
  });

  it('evicts the oldest entry once MAX_ENTRIES (300) is exceeded', () => {
    const cache = new QueueCoverArtCache();
    for (let i = 0; i < 300; i++) cache.set(`track${i}`, `art${i}`);
    expect(cache.get('track0')).toBe('art0');

    cache.set('track300', 'art300');

    expect(cache.get('track0')).toBeUndefined();
    expect(cache.get('track1')).toBe('art1');
    expect(cache.get('track300')).toBe('art300');
  });

  it('clear() empties the cache', () => {
    const cache = new QueueCoverArtCache();
    cache.set('track1', 'art1');
    cache.clear();
    expect(cache.has('track1')).toBe(false);
  });
});
