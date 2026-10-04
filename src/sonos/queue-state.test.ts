import { describe, expect, it } from 'vitest';
import { isBrowsableQueue } from './SonosTypes';

describe('isBrowsableQueue', () => {
    it('is the speaker\'s own queue with more than one track', () => {
        expect(isBrowsableQueue({ uri: 'x-rincon-queue:RINCON_X#0', tracks: 30 })).toBe(true);
    });

    it('is not Music Assistant\'s single-stream queue (hardware probe 2026-10-03)', () => {
        expect(isBrowsableQueue({ uri: 'x-rincon-queue:RINCON_X#121', tracks: 1 })).toBe(false);
    });

    it('is not an old queue that Music Assistant plays its own track through (hardware 2026-10-04)', () => {
        const q = { uri: 'x-rincon-queue:RINCON_X#140', tracks: 12 };
        expect(isBrowsableQueue(q, 'http://192.168.7.136:8097/single/wAivmykd/RINCON_X/cc4e/RINCON_X.flac')).toBe(false);
        expect(isBrowsableQueue(q, 'x-sonos-http:track%2f87387745.mp4?sid=174')).toBe(true);
    });

    it('is not a station or an unknown state', () => {
        expect(isBrowsableQueue({ uri: 'x-sonosapi-hls:station', tracks: 0 })).toBe(false);
        expect(isBrowsableQueue(undefined)).toBe(false);
    });
});
