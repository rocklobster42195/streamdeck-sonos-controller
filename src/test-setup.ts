import { vi } from 'vitest';

// @elgato/streamdeck creates a `logs/` directory as a side effect of being imported
// (its file logger initializes on load). Stub it out so unit tests exercising pure
// logic don't touch the filesystem or need a running Stream Deck host.
vi.mock('@elgato/streamdeck', () => ({
  default: {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  },
}));
