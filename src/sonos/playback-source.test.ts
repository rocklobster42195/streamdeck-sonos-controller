import { describe, expect, it } from 'vitest';
import { parseSource } from './playback-source';

describe('parseSource', () => {
    it('reads the lib\'s parsed track', () => {
        expect(parseSource({ Title: 'Evening Jazz', UpnpClass: 'object.container.playlistContainer' }, 'x-rincon-cpcontainer:abc'))
            .toEqual({ title: 'Evening Jazz', upnpClass: 'object.container.playlistContainer', uri: 'x-rincon-cpcontainer:abc' });
    });

    it('reads raw DIDL-Lite', () => {
        const didl = '<DIDL-Lite><item><dc:title>Some Station</dc:title><upnp:class>object.item.audioItem.audioBroadcast</upnp:class></item></DIDL-Lite>';
        expect(parseSource(didl, '')).toEqual({ title: 'Some Station', upnpClass: 'object.item.audioItem.audioBroadcast', uri: undefined });
    });

    it('knows no source without a title (e.g. a stream from another app)', () => {
        expect(parseSource('', '')).toBeUndefined();
        expect(parseSource({ Title: '  ' }, 'x-sonos-http:stream')).toBeUndefined();
        expect(parseSource(undefined, undefined)).toBeUndefined();
    });
});
