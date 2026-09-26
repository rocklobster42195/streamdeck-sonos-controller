import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { pickListenerHost } from './listener-host';

function v4(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
    return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null };
}

describe('pickListenerHost', () => {
    it('picks the address in the speaker subnet, not the first interface (VPN listed first)', () => {
        const ifaces = {
            'Teleport': [v4('192.168.2.3', '255.255.255.0')],
            'Ethernet 3': [v4('192.168.7.40', '255.255.255.0')],
        };
        expect(pickListenerHost(ifaces, '192.168.7.210')).toBe('192.168.7.40');
    });

    it('returns undefined when only a VPN address exists (speakers could not reach us)', () => {
        const ifaces = { 'Teleport': [v4('192.168.2.3', '255.255.255.0')] };
        expect(pickListenerHost(ifaces, '192.168.7.210')).toBeUndefined();
    });

    it('respects wider netmasks', () => {
        const ifaces = { 'LAN': [v4('10.0.200.5', '255.255.0.0')] };
        expect(pickListenerHost(ifaces, '10.0.7.9')).toBe('10.0.200.5');
    });

    it('ignores loopback, IPv6 and malformed entries', () => {
        const ifaces = {
            'lo': [v4('127.0.0.1', '255.0.0.0', true)],
            'LAN': [
                { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 1 } as NetworkInterfaceInfo,
                v4('192.168.7.40', '255.255.255.0'),
            ],
        };
        expect(pickListenerHost(ifaces, '192.168.7.210')).toBe('192.168.7.40');
        expect(pickListenerHost(ifaces, 'not-an-ip')).toBeUndefined();
    });

    it('handles addresses above 128.0.0.0 (sign bit)', () => {
        const ifaces = { 'LAN': [v4('200.1.2.3', '255.255.255.0')] };
        expect(pickListenerHost(ifaces, '200.1.2.99')).toBe('200.1.2.3');
        expect(pickListenerHost(ifaces, '200.1.3.99')).toBeUndefined();
    });
});
