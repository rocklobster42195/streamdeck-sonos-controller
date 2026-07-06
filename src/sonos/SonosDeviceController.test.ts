import { describe, it, expect } from 'vitest';
import { SonosDeviceController } from './SonosDeviceController';

describe('SonosDeviceController.isRadioStream', () => {
  it.each([
    'x-sonosapi-stream:s12345?sid=254',
    'x-sonosapi-radio:spotify:artistRadio:123',
    'x-sonosapi-hls:some-station',
    'x-rincon-stream:RINCON_000E58ABCDEF01400',
    'aac:http://stream.example.com/live',
    'pndrradio:12345',
    'x-sonos-http:tr:12345.mp3-DZR:track',
  ])('recognizes %s as a radio stream', (uri) => {
    expect(SonosDeviceController.isRadioStream(uri)).toBe(true);
  });

  it.each([
    'x-file-cifs://NAS/music/track.mp3',
    'x-sonos-spotify:spotify:track:abc?sid=9',
    'x-rincon-cpcontainer:1006206ccatalog',
    'x-sonos-http:tr:12345.mp3',
  ])('does not treat %s as a radio stream', (uri) => {
    expect(SonosDeviceController.isRadioStream(uri)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(SonosDeviceController.isRadioStream(undefined)).toBe(false);
  });
});
