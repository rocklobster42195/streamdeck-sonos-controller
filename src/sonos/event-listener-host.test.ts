import { describe, it, expect, vi } from 'vitest';
import BaseService from '@svrooij/sonos/lib/services/base-service';
import { AVTransportService } from '@svrooij/sonos/lib/services/av-transport.service';

vi.mock('@elgato/streamdeck', () => ({ default: { logger: { warn: vi.fn(), info: vi.fn() } } }));

import { guardEventParsing } from './event-listener-host';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// What a Sonos Port sends when a line-in source loads: a bare `x-rincon-stream` attribute (svrooij/node-sonos-ts#229).
const LINE_IN_DIDL = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="playback"><res x-rincon-stream>x-rincon-stream:RINCON_X:0</res></item></DIDL-Lite>';
const lastChange = (didl: string) => esc(`<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0"><TransportState val="PLAYING"/><AVTransportURIMetaData val="${esc(didl)}"/></InstanceID></Event>`);
const wrap = (inner: string) => `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>${inner}</LastChange></e:property></e:propertyset>`;

describe('guardEventParsing', () => {
    it('swallows the line-in XmlError instead of throwing out of the HTTP handler', () => {
        const svc = new AVTransportService('127.0.0.1', 1400);
        const proto = BaseService.prototype as unknown as { ParseEvent(xml: string): void };
        const unguarded = proto.ParseEvent;
        expect(() => unguarded.call(svc, wrap(lastChange(LINE_IN_DIDL)))).toThrow(/Attribute value expected/);

        guardEventParsing();
        expect(() => proto.ParseEvent.call(svc, wrap(lastChange(LINE_IN_DIDL)))).not.toThrow();
        expect(() => proto.ParseEvent.call(svc, '<<<not xml')).not.toThrow();
    });
});
