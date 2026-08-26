// Checks whether a bonded Sonos stereo pair (e.g. two speakers in one room acting as one stereo
// zone) shows up as a single device or as two — and why. Sonos's real UPnP zone topology marks
// the non-primary half of a bonded pair with Invisible="1" on its ZoneGroupMember element, but
// SonosManager.Devices (what this plugin's device dropdown is built from) never filters that out
// — GetParsedZoneGroupState() is the only API that actually exposes the flag. This script prints
// both views side by side so a real household's topology can be inspected before trusting a fix.
//
// Run: node tools/diagnose-stereo-pairs.mjs [manual-ip]
//   - No argument: discovers players via SSDP (InitializeWithDiscovery).
//   - An IP address: connects directly to that speaker (InitializeFromDevice), bypassing SSDP —
//     useful if discovery is blocked on this machine's network.

import { SonosManager } from '@svrooij/sonos';

const manualIp = process.argv[2];
const manager = new SonosManager();

try {
    if (manualIp) {
        console.log(`Connecting directly to ${manualIp} ...`);
        await manager.InitializeFromDevice(manualIp);
    } else {
        console.log('Discovering Sonos players via SSDP ...');
        await manager.InitializeWithDiscovery();
    }
} catch (err) {
    console.error('Failed to reach any Sonos player:', err);
    console.error('Try passing a known speaker IP directly: node tools/diagnose-stereo-pairs.mjs 192.168.x.x');
    process.exit(1);
}

if (manager.Devices.length === 0) {
    console.error('No players found.');
    process.exit(1);
}

console.log(`Found ${manager.Devices.length} device(s) via SonosManager.Devices.\n`);

// --- Ground truth: the real zone topology, including the Invisible flag ---

const groups = await manager.Devices[0].ZoneGroupTopologyService.GetParsedZoneGroupState();

console.log('=== Real zone topology (GetParsedZoneGroupState) ===');
const invisibleHosts = new Set();
for (const group of groups) {
    console.log(`\nGroup "${group.name}" (coordinator: ${group.coordinator.name} @ ${group.coordinator.host})`);
    for (const member of group.members) {
        const flags = [
            member.Invisible ? 'INVISIBLE (bonded satellite)' : 'visible',
            member.ChannelMapSet ? `channelMap=${JSON.stringify(member.ChannelMapSet)}` : undefined,
            member.Satellites?.length ? `${member.Satellites.length} HT satellite(s)` : undefined,
        ].filter(Boolean).join(', ');
        console.log(`  - ${member.name.padEnd(20)} host=${member.host.padEnd(15)} uuid=${member.uuid}  [${flags}]`);
        if (member.Invisible) invisibleHosts.add(member.host);
    }
}

// --- What the plugin's device dropdown currently shows (sendDeviceList in src/actions/pi-options.ts) ---

console.log('\n=== Current device dropdown (sendDeviceList — one entry per SonosManager.Devices) ===');
for (const d of manager.Devices) {
    const marker = invisibleHosts.has(d.Host) ? '  <-- duplicate: invisible stereo-pair satellite' : '';
    console.log(`  - ${d.Name.padEnd(20)} host=${d.Host}${marker}`);
}

// --- What the fixed dropdown would show once invisible hosts are filtered ---

const visible = manager.Devices.filter((d) => !invisibleHosts.has(d.Host));
console.log('\n=== Device dropdown AFTER filtering invisible satellites ===');
for (const d of visible) {
    console.log(`  - ${d.Name.padEnd(20)} host=${d.Host}`);
}

// --- What the group dropdown shows today (sendGroupList — dedupes by coordinator host already) ---

console.log('\n=== Current group dropdown (sendGroupList — dedupes by coordinator host) ===');
const seen = new Set();
for (const d of manager.Devices) {
    const coordinator = d.Coordinator ?? d;
    if (seen.has(coordinator.Host)) continue;
    seen.add(coordinator.Host);
    console.log(`  - ${(d.GroupName ?? coordinator.Name).padEnd(30)} host=${coordinator.Host}`);
}

console.log(
    invisibleHosts.size > 0
        ? `\n${invisibleHosts.size} invisible satellite(s) found — these are what cause a stereo pair's room name to appear twice in the device dropdown.`
        : '\nNo invisible satellites found in this household — no stereo/HT-bonded pairs detected right now.'
);

process.exit(0);
