import { describe, it, expect } from 'vitest';
import { parsePlayMode, toPlayMode } from './play-mode';

describe('play mode', () => {
  it('reads every Sonos play mode', () => {
    expect(parsePlayMode('NORMAL')).toEqual({ shuffle: false, repeat: 'off' });
    expect(parsePlayMode('REPEAT_ONE')).toEqual({ shuffle: false, repeat: 'one' });
    expect(parsePlayMode('SHUFFLE')).toEqual({ shuffle: true, repeat: 'all' });
    expect(parsePlayMode('SHUFFLE_NOREPEAT')).toEqual({ shuffle: true, repeat: 'off' });
    expect(parsePlayMode(undefined)).toEqual({ shuffle: false, repeat: 'off' });
  });

  it('round-trips every combination', () => {
    for (const shuffle of [false, true]) {
      for (const repeat of ['off', 'all', 'one'] as const) expect(parsePlayMode(toPlayMode(shuffle, repeat))).toEqual({ shuffle, repeat });
    }
  });
});
