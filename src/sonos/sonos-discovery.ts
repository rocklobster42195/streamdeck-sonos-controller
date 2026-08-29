import streamDeck from "@elgato/streamdeck";
import { SonosManager, SonosEventListener, SonosDevice, SonosDeviceDiscovery } from "@svrooij/sonos";
import { sonosFavoritesCache } from "./SonosFavoritesCache";
import { withTimeout } from "../utils/with-timeout";

// A cached IP that's gone stale (device replaced, moved networks) can otherwise hang for the
// OS-level TCP connect timeout instead of failing fast — same reasoning as every other
// withTimeout use in this codebase.
//
// 10s (was 6s) + CACHED_IP_ATTEMPTS tries: the cached IP is the single strongest signal for
// "which Sonos household is really mine", and a 6s one-shot lost that race on hardware
// (2026-08-28) when the configured coordinator was briefly asleep at plugin start — discovery
// fell straight through to SSDP and adopted a *foreign* household visible over a VPN (a friend's
// network the user was on). Giving the cached IP a longer, retried window before the SSDP
// fallback makes that scenario recover on its own. Worst case when the cached device really is
// gone (moved to a brand-new network, first-ever run): ~21s of the first discoveryPromise spent
// here before SSDP — deemed acceptable against the same ~30s worst case DISCOVERY_RETRY_MS
// already tolerates, and the household check (see resolveHouseholdHost) is the real backstop.
const CACHED_IP_TIMEOUT_MS = 10_000;
const CACHED_IP_ATTEMPTS = 2;
const CACHED_IP_RETRY_GAP_MS = 1_000;

// Per-responder GetHouseholdID probe during the SSDP fallback — these IPs just answered an
// M-SEARCH so they're reachable now; 4s is plenty and keeps a network with many players from
// dragging the whole probe loop out.
const HOUSEHOLD_PROBE_MS = 4_000;

// SSDP fallback (only runs when the cached IP didn't work).
// Search() enumerates ALL responders so a pinned household can be picked out even if a foreign one
// answers first — but it always waits the full window, so keep it short. SearchOne() (unpinned
// case) resolves the moment any device answers; its value is just an upper bound.
const SSDP_SEARCH_SECONDS = 8;
const SSDP_SEARCH_ONE_SECONDS = 10;

export const sonosManager = new SonosManager();

// SonosManager's own `.Devices` getter THROWS ("No Devices available!") whenever its internal
// list is empty — not just before discovery has ever run, but for the entire lifetime of any
// session where discovery keeps failing (e.g. SSDP multicast blocked by a VPN adapter taking
// over the default route — confirmed as the trigger 2026-07-17: WireGuard was active). Every
// PI-facing caller used to read `sonosManager.Devices` directly; a couple of call sites
// (pi-options.ts's sendDeviceList/sendGroupList, SonosGroupController's resolveCoordinator) had
// no try/catch around that read at all. The @elgato/streamdeck SDK only installs a ONE-SHOT
// `process.once('uncaughtException', ...)` handler (logs and survives the first escape, but is
// then gone) — so the first uncaught throw from this getter was survivable, but ANY second one
// crashed the entire plugin process with no further logging, hanging every action's PI
// simultaneously (not just the one that happened to trigger it) until a manual restart. This
// safe wrapper is now the only sanctioned way to read the device list.
export function safeDevices(): SonosDevice[] {
    try {
        return sonosManager.Devices;
    } catch {
        return [];
    }
}

// Listener host after discovery — module-internal, only used for the startup log below.
let eventListenerHost: string | undefined;

// A bonded Sonos stereo pair's non-primary speaker (and an HT setup's satellites/sub) reports the
// SAME room name as its visible partner in sonosManager.Devices, differing only by its own
// (hidden) IP — Sonos's real UPnP topology marks it Invisible="1", but SonosManager never copies
// that flag onto the SonosDevice objects it builds; only ZoneGroupTopologyService's own
// GetParsedZoneGroupState() exposes it (confirmed by reading @svrooij/sonos's source directly,
// see tools/diagnose-stereo-pairs.mjs and the notes filed in the node-sonos-ts fork). Without
// this, every consumer that lists/counts devices sees a bonded room twice.
//
// Cached and refreshed once per successful discovery rather than fetched live on every read —
// SonosGroupController re-derives group membership/naming from this on every topology
// poll/push (several times a minute per active group), and re-issuing the underlying SOAP call
// that often would add needless network chatter for something (stereo/HT bonding) that in
// practice never changes mid-session. A user who re-bonds/un-bonds speakers while the plugin is
// running won't see it reflected until the next discovery/plugin restart — an acceptable
// trade-off for how rare that action is.
let invisibleSatelliteHostsCache: Set<string> = new Set();

async function refreshInvisibleSatelliteHosts(): Promise<void> {
    try {
        const groups = await safeDevices()[0]?.ZoneGroupTopologyService.GetParsedZoneGroupState();
        const hosts = new Set<string>();
        for (const group of groups ?? []) {
            for (const member of group.members) {
                if (member.Invisible) hosts.add(member.host);
            }
        }
        invisibleSatelliteHostsCache = hosts;
    } catch (e) {
        streamDeck.logger.debug('Failed to resolve stereo/HT-bonded satellite hosts', e);
    }
}

/** True for a bonded stereo/HT pair's invisible non-primary speaker — see the cache's own doc
 *  comment above for why this exists and how it's kept (reasonably) fresh. */
export function isInvisibleSatellite(host: string): boolean {
    return invisibleSatelliteHostsCache.has(host);
}

// A failed SSDP discovery is retried until it succeeds. Without this, one bad round at plugin
// start ("No players found" — seen on hardware right after a plugin restart) left the entire
// session with an empty sonosManager: no PI device lists, and — much worse — no group topology,
// so a grouped member's transportDevice fell back to the member itself and every cover fetch for
// it 404'd against the member's own /getaa (observed as "grouped Roam never gets a cover").
//
// 5s, not the original 20s: each retry's own InitializeWithDiscovery(10) already spends up to 10s
// waiting for a response before giving up (SearchOne's default timeout — left untouched here,
// since it resolves near-instantly once ANY device answers, and shortening it would risk giving
// up on a genuinely-just-slow-to-respond network before it gets a chance). Confirmed via the
// plugin's own log (2026-07-17): a real run needed 3 attempts — 10s fail, 20s wait, 10s fail, 20s
// wait, ~6s success — 66s total before ANY PI device dropdown could populate. The 20s gap between
// attempts had no empirical basis (SSDP M-SEARCH retries are cheap, lightweight UDP broadcasts,
// not worth throttling this conservatively on a home LAN) — 5s cuts the same 3-attempt worst case
// to roughly 30s.
const DISCOVERY_RETRY_MS = 5_000;

// Guards against two runDiscovery() calls overlapping — needed once the manual-IP listener
// below can trigger a call outside the normal retry chain. InitializeWithDiscovery/
// InitializeFromDevice aren't designed to be re-entered mid-flight.
let discoveryInFlight = false;

// The scheduled retry from a previous failure — the manual-IP listener cancels this so it
// doesn't fire a redundant second attempt right on top of the one it just triggered.
let pendingRetryTimeout: ReturnType<typeof setTimeout> | undefined;

// Fired every time discovery actually succeeds — including a LATER retry after the first attempt
// failed. discoveryPromise only ever waits for that first attempt (see its own comment below), so
// any PI that requested its device/group dropdown right at plugin startup and raced against a
// failed or still-in-flight first attempt was sent an empty list and never got another one —
// observed as "devices don't load cleanly after a restart" (the dropdown just shows the
// placeholder forever, even though sonosManager fills in correctly a few seconds later). Letting
// pi-options.ts re-push both lists once discovery actually lands repairs that dropdown without
// the user having to close and reopen the PI.
const devicesChangedListeners = new Set<() => void>();

export function onDevicesChanged(cb: () => void): void {
    devicesChangedListeners.add(cb);
}

interface DiscoveryGlobalSettings {
    [key: string]: string | undefined;
    lastKnownDeviceIp?: string;
    // The Sonos HouseholdID (e.g. "Sonos_xxxxxxxxxxxxxxxx") this plugin is bound to. Set from the
    // first device of the first successful discovery and then enforced on every subsequent one —
    // if SSDP later surfaces only a *different* household (a foreign system reachable over a VPN
    // or guest network — confirmed root cause 2026-08-28: favorites + GroupVolumeDial came up
    // wrong because a friend's Sonos won the SSDP race while the user's own coordinator was
    // briefly asleep), that discovery is rejected and retried rather than adopted.
    //
    // Reset: entering a reachable IP from a different household into any PI's manual-IP field
    // (which writes lastKnownDeviceIp) is treated as an explicit "switch systems" — the pin is
    // cleared and re-derived from that device. A pinned household that is merely unreachable for
    // a while (power cut, router swap, user travelling) is never auto-cleared; only that manual
    // action clears it.
    householdId?: string;
}

// setGlobalSettings replaces the whole payload, so a bare setGlobalSettings({ lastKnownDeviceIp })
// would wipe householdId (and vice-versa). Every write goes through here: read current, merge the
// patch, write back. `undefined` values in the patch delete that key.
async function patchGlobalSettings(patch: Partial<DiscoveryGlobalSettings>): Promise<void> {
    let current: DiscoveryGlobalSettings = {};
    try {
        current = await streamDeck.settings.getGlobalSettings<DiscoveryGlobalSettings>();
    } catch { /* first write of the session, or read failed — start from empty */ }
    const merged: DiscoveryGlobalSettings = { ...current, ...patch };
    for (const k of Object.keys(merged)) {
        if (merged[k] === undefined) delete merged[k];
    }
    await streamDeck.settings.setGlobalSettings<DiscoveryGlobalSettings>(merged);
}

async function getPinnedHouseholdId(): Promise<string | undefined> {
    try {
        return (await streamDeck.settings.getGlobalSettings<DiscoveryGlobalSettings>()).householdId;
    } catch {
        return undefined;
    }
}

// A plain SOAP GetHouseholdID against one IP, bounded like every other startup call. Returns
// undefined on any failure — callers treat that as "couldn't determine", never as a mismatch, so
// a transient hiccup can't lock the plugin out of its own system.
async function readHouseholdId(host: string, timeoutMs = HOUSEHOLD_PROBE_MS): Promise<string | undefined> {
    try {
        const res = await withTimeout(
            new SonosDevice(host).DevicePropertiesService.GetHouseholdID(),
            timeoutMs,
            `GetHouseholdID (${host})`,
        );
        return res?.CurrentHouseholdID || undefined;
    } catch (e) {
        streamDeck.logger.debug(`Could not read HouseholdID from ${host}`, e);
        return undefined;
    }
}

// Picks an IP that belongs to the pinned Sonos household (or, when nothing is pinned yet, the
// first Sonos found) — WITHOUT letting sonosManager touch anything until the household is vetted.
// sonosManager has no way to un-adopt a household once InitializeFrom* has run, so the check has
// to happen before that, not after. Throws when nothing suitable is reachable → runDiscovery
// retries on its normal cadence.
async function resolveHouseholdHost(): Promise<string> {
    const pinned = await getPinnedHouseholdId();

    // 1. Cached / manual IP first — bypasses SSDP entirely (VPN or Windows "Public" profile
    //    silently dropping inbound multicast; see noteReachableDeviceIp's comment below).
    let cachedIp: string | undefined;
    try {
        cachedIp = (await streamDeck.settings.getGlobalSettings<DiscoveryGlobalSettings>()).lastKnownDeviceIp;
    } catch { /* fall through to SSDP */ }

    if (cachedIp) {
        for (let attempt = 1; attempt <= CACHED_IP_ATTEMPTS; attempt++) {
            const hh = await readHouseholdId(cachedIp, CACHED_IP_TIMEOUT_MS);
            if (hh && (!pinned || hh === pinned)) return cachedIp;
            if (hh && pinned && hh !== pinned) {
                streamDeck.logger.warn(`Cached/manual IP ${cachedIp} is in Sonos household ${hh}, not the pinned ${pinned} — ignoring it.`);
                break; // a wrong-household cached IP won't become right by retrying
            }
            // hh === undefined: device unreachable right now (briefly asleep on hardware
            // 2026-08-28). Retry before giving up on the strongest household signal we have.
            streamDeck.logger.warn(`Cached/manual IP ${cachedIp} unreachable — attempt ${attempt}/${CACHED_IP_ATTEMPTS}.`);
            if (attempt < CACHED_IP_ATTEMPTS) await new Promise((r) => setTimeout(r, CACHED_IP_RETRY_GAP_MS));
        }
    }

    // 2. SSDP fallback.
    //    Unpinned: adopt whoever answers first (SearchOne — fast, matches the old
    //    InitializeWithDiscovery behaviour so a first-ever run's PI dropdowns don't wait).
    //    Pinned: enumerate ALL responders (Search) and filter by household, so a foreign system
    //    that replies faster can't shadow the pinned one.
    if (!pinned) {
        return (await new SonosDeviceDiscovery().SearchOne(SSDP_SEARCH_ONE_SECONDS)).host;
    }
    const players = await new SonosDeviceDiscovery().Search(SSDP_SEARCH_SECONDS);
    for (const p of players) {
        if (await readHouseholdId(p.host) === pinned) return p.host;
    }
    throw new Error(
        `SSDP found ${players.length} player(s) but none in the pinned household ${pinned} — ` +
        `retrying in ${DISCOVERY_RETRY_MS / 1000}s (own system likely off/asleep, or only a foreign one is reachable).`,
    );
}

// After a successful init: if no household is pinned yet, pin whatever we just connected to. When
// one IS pinned, resolveHouseholdHost already guaranteed the match, so there's nothing to do.
async function pinHouseholdIfUnpinned(): Promise<void> {
    if (await getPinnedHouseholdId()) return;
    const hh = await readHouseholdId(sonosManager.Devices[0].Host, CACHED_IP_TIMEOUT_MS);
    if (hh) {
        await patchGlobalSettings({ householdId: hh });
        streamDeck.logger.info(`Pinned Sonos household to ${hh} (${sonosManager.Devices[0].Name}).`);
    } else {
        streamDeck.logger.warn('Could not read HouseholdID after first discovery — will pin on a later run.');
    }
}

// SSDP discovery depends on UDP multicast/broadcast responses actually reaching this process —
// confirmed on hardware (2026-07-18): after a laptop sleep/wake cycle, Windows can reclassify the
// network as "Public" and silently block inbound SSDP responses while normal outbound HTTP keeps
// working fine (direct requests to every known device IP succeeded even though SSDP discovery
// failed for 10+ minutes straight). InitializeFromDevice() bypasses SSDP entirely — it's a plain
// HTTP/SOAP call to one known IP, which then pulls the full household topology the same way
// InitializeWithDiscovery does internally. Caching the last successfully-used IP and trying it
// FIRST means a repeat of that exact scenario recovers on its own, without the user needing to
// fix their network profile or restart the plugin — falls through to normal SSDP discovery if the
// cached IP is stale/gone (device replaced, moved to a new network, first-ever run, etc).
// Called by any SonosDeviceController the moment ITS OWN direct (non-discovery) communication
// with a device succeeds — independent of whether sonosManager/SSDP has ever worked this session.
// Without this, the cache could only ever be seeded by a successful sonosManager-based discovery,
// which is exactly the thing failing — a chicken-and-egg deadlock confirmed on hardware
// (2026-07-18): individual dials worked fine all session (their configured device answered direct
// HTTP calls just fine) while sonosManager/SSDP kept failing and favorites never loaded (favorites
// cache only starts from a successful discovery), yet nothing ever primed the fallback because
// discovery itself never got the one success it needed. Seeding it from ANY working controller
// breaks that: the next retry (at most DISCOVERY_RETRY_MS away) tries this IP via
// InitializeFromDevice and recovers immediately, with no restart and no OS-level network fix
// needed.
export function noteReachableDeviceIp(ip: string): void {
    patchGlobalSettings({ lastKnownDeviceIp: ip })
        .catch((e) => streamDeck.logger.debug('Failed to cache reachable device IP', e));
}

async function runDiscovery(): Promise<void> {
    if (discoveryInFlight) return;
    discoveryInFlight = true;
    try {
        // Resolve a vetted host (cached IP, else SSDP-enumerate + household-filter) BEFORE handing
        // it to sonosManager — which can't un-adopt a household once it has one.
        const host = await resolveHouseholdHost();
        await withTimeout(sonosManager.InitializeFromDevice(host), CACHED_IP_TIMEOUT_MS, `InitializeFromDevice (${host})`);
        if (sonosManager.Devices.length === 0) throw new Error('Discovery returned no players');

        await pinHouseholdIfUnpinned();

        const listenerStatus = SonosEventListener.DefaultInstance.GetStatus();
        if (listenerStatus) {
            eventListenerHost = listenerStatus.host;
        }
        streamDeck.logger.info(`Sonos device discovery completed. Found ${sonosManager.Devices.length} players.`);
        streamDeck.logger.info(`Using event listener host: ${eventListenerHost}`);
        sonosManager.Devices.forEach(d => {
            streamDeck.logger.info(`- ${d.Name} (${d.Host})`);
        });
        noteReachableDeviceIp(sonosManager.Devices[0].Host);
        await sonosFavoritesCache.start(sonosManager.Devices[0]);
        void refreshInvisibleSatelliteHosts();
        devicesChangedListeners.forEach(cb => cb());
    } catch (err) {
        streamDeck.logger.error(`Sonos discovery failed — retrying in ${DISCOVERY_RETRY_MS / 1000}s:`, err);
        pendingRetryTimeout = setTimeout(() => void runDiscovery(), DISCOVERY_RETRY_MS);
    } finally {
        discoveryInFlight = false;
    }
}

// A manual IP typed into a PI's manual-IP field while a system is ALREADY up is an explicit
// "switch to this system": if that IP is reachable and sits in a different Sonos household than
// the pinned one, clear the pin and re-run discovery (which re-pins from this IP via the cached-IP
// path). Same-household re-entries are ignored so there's no needless teardown. This is the only
// path that clears a household pin — an unreachable-for-a-while pinned system is never auto-reset.
async function maybeSwitchHousehold(ip: string): Promise<void> {
    if (discoveryInFlight) return;
    const pinned = await getPinnedHouseholdId();
    if (!pinned) return; // nothing pinned; a running-but-unpinned session pins on its next run

    const actual = await readHouseholdId(ip);
    if (!actual || actual === pinned) return;

    streamDeck.logger.info(
        `Manual IP ${ip} is in Sonos household ${actual}, not the pinned ${pinned} — treating as an ` +
        `explicit system switch: clearing the pin and re-initializing.`,
    );
    await patchGlobalSettings({ householdId: undefined, lastKnownDeviceIp: ip });
    if (pendingRetryTimeout) clearTimeout(pendingRetryTimeout);
    await runDiscovery();
}

// Lets a user recover from a fully SSDP-blocked network (e.g. Sonos speakers isolated on a
// separate VLAN, multicast never reaching this process) by typing the speaker's IP into the new
// PI "manual IP" field — see the sdpi-textfield in each ui/*.html — which writes straight into
// this same lastKnownDeviceIp global setting via sdpi-components' `global` attribute, no plugin
// code involved in that write. Without this listener, that write would still work eventually
// (the retry loop above already tries the cached IP first on every attempt), but the user would
// be staring at an empty device dropdown for up to DISCOVERY_RETRY_MS before it kicks in.
//
// `onDidReceiveGlobalSettings` ALSO fires as an echo of this plugin's own `getGlobalSettings()`
// reads (tryFromCachedIp does one every attempt) and of noteReachableDeviceIp's own writes — not
// just of PI-side edits. Reacting to every echo would spawn a redundant runDiscovery() on top of
// the one already running, repeating forever. The `changed` check below (comparing against the
// last value THIS listener observed, not against what discovery is currently trying) is what
// makes it only fire on a genuinely new value — i.e. an actual PI edit.
//
// MUST use safeDevices(), not sonosManager.Devices directly — this listener fires on every
// global-settings round trip (including the ones the very first, still-in-flight runDiscovery()
// triggers), i.e. routinely while Devices is still empty. Confirmed on hardware (2026-07-18): an
// earlier version read sonosManager.Devices.length directly here and the getter's throw
// ("No Devices available!") happened uncaught inside the connection's message-handling callback,
// visible in the log as "Connection: Failed to parse message" — exactly the crash-the-whole-
// process failure mode safeDevices() exists to prevent (see its own comment above).
let lastSeenGlobalIp: string | undefined;
streamDeck.settings.onDidReceiveGlobalSettings<DiscoveryGlobalSettings>((ev) => {
    const ip = ev.settings.lastKnownDeviceIp;
    const changed = ip !== lastSeenGlobalIp;
    lastSeenGlobalIp = ip;
    if (!changed || !ip) return;
    if (safeDevices().length === 0) {
        if (pendingRetryTimeout) clearTimeout(pendingRetryTimeout);
        void runDiscovery();
    } else {
        // Already have a working system — only re-initialize if this IP is a deliberate switch to
        // a different household (see maybeSwitchHousehold); a same-household entry is a no-op.
        void maybeSwitchHousehold(ip);
    }
});

// Start discovery immediately, but don't block plugin initialization.
// Export the promise so other parts of the plugin can wait for it. Resolves after the FIRST
// attempt either way (so PI device lists don't hang forever on a bad network) — later retries
// fill sonosManager in the background.
export const discoveryPromise = runDiscovery();

/**
 * A shared cache for Sonos favorites and their cover art.
 */
export { sonosFavoritesCache };
