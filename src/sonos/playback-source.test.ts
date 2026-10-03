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

describe('upnpSourceOf', () => {
    it('takes a station from AVTransportURI when not playing from the queue', async () => {
        const { upnpSourceOf } = await import('./playback-source');
        expect(upnpSourceOf({ AVTransportURI: 'x-sonosapi-hls:station', AVTransportURIMetaData: { Title: 'Some Radio', UpnpClass: 'object.item.audioItem.audioBroadcast' } }))
            .toEqual({ title: 'Some Radio', upnpClass: 'object.item.audioItem.audioBroadcast', uri: 'x-sonosapi-hls:station' });
    });

    it('knows nothing for queue playback without EnqueuedTransportURI (current firmware)', async () => {
        const { upnpSourceOf } = await import('./playback-source');
        expect(upnpSourceOf({ AVTransportURI: 'x-rincon-queue:RINCON_X#0', AVTransportURIMetaData: '0' })).toBeNull();
    });

    it('prefers EnqueuedTransportURI where it is still sent', async () => {
        const { upnpSourceOf } = await import('./playback-source');
        expect(upnpSourceOf({ AVTransportURI: 'x-rincon-queue:RINCON_X#0', EnqueuedTransportURI: 'x-rincon-cpcontainer:1', EnqueuedTransportURIMetaData: { Title: 'Evening' } })?.title).toBe('Evening');
    });
});

describe('sourceFromContainer (local API)', () => {
    it('maps the container type and keeps service and id', async () => {
        const { sourceFromContainer } = await import('./sonos-local-api');
        expect(sourceFromContainer({ name: 'Spotify playlist', type: 'playlist', id: { objectId: 'spotify:playlist:abc' }, service: { name: 'Spotify' } }))
            .toEqual({ title: 'Spotify playlist', upnpClass: 'object.container.playlistContainer', service: 'Spotify', objectId: 'spotify:playlist:abc' });
        expect(sourceFromContainer({ type: 'playlist' })).toBeUndefined();
        expect(sourceFromContainer(undefined)).toBeUndefined();
    });
});
