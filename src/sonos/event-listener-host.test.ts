import { describe, it, expect, vi } from 'vitest';
import BaseService from '@svrooij/sonos/lib/services/base-service';

vi.mock('@elgato/streamdeck', () => ({ default: { logger: { warn: vi.fn(), info: vi.fn() } } }));

import { guardEventParsing } from './event-listener-host';

const LINE_IN_DIDL = '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="playback"><res x-rincon-stream>x-rincon-stream:RINCON_X:0</res></item></DIDL-Lite>';

describe('guardEventParsing', () => {
    it('swallows a malformed event instead of throwing out of the HTTP handler', () => {
        guardEventParsing();
        const proto = BaseService.prototype as unknown as { ParseEvent(xml: string): void };
        const svc = Object.create(proto);
        const body = `<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>${LINE_IN_DIDL.replace(/</g, '&lt;')}</LastChange></e:property></e:propertyset>`;
        expect(() => proto.ParseEvent.call(svc, body)).not.toThrow();
        expect(() => proto.ParseEvent.call(svc, '<<<not xml')).not.toThrow();
    });
});
