import { networkInterfaces } from "node:os";
import streamDeck from "@elgato/streamdeck";
import { SonosEventListener, ServiceEvents } from "@svrooij/sonos";
import BaseService from "@svrooij/sonos/lib/services/base-service";
import { pickListenerHost } from "./listener-host";

// Keeps the GENA callback address the speakers get pointed at in step with the network the PC is
// actually on (see listener-host.ts for why the lib's own pick is dangerous). Three states:
//   - a local address shares the speakers' subnet → use it for every (re)subscription
//   - none does (PC is on a VPN / another network) → subscribe to NOTHING; the 8s poll loops keep
//     every action working, just without instant events. A dead callback would otherwise stall
//     event delivery for every other controller on those speakers (HA, Music Assistant, …).
//   - the network changes while running → cancel and resubscribe with the new address, or
//     cancel everything (and park it) when the speakers become unreachable, and bring parked
//     subscriptions back once they're reachable again.
// The lib has no hook for any of this, so subscribeForEvents is wrapped on the shared BaseService
// prototype. The members used below are private in the lib's typings but plain at runtime.

type Service = {
    sid?: string;
    eventRenewInterval?: NodeJS.Timeout;
    events?: { listenerCount(event: string): number };
    subscribeForEvents(): Promise<boolean>;
    cancelSubscription(): Promise<boolean>;
};

const WATCH_INTERVAL_MS = 30_000;

let wrapped = false;
let blocked = false;
const parked = new Set<Service>();
let watchTimer: NodeJS.Timeout | undefined;

function wrapSubscribe(): void {
    if (wrapped) return;
    wrapped = true;
    const proto = BaseService.prototype as unknown as Service;
    const original = proto.subscribeForEvents;
    proto.subscribeForEvents = async function (this: Service): Promise<boolean> {
        if (blocked) {
            parked.add(this); // remembered so it can subscribe once the speakers can reach us again
            return false;
        }
        // cancelSubscription() clears the renew timer but doesn't reset the field, and the lib
        // only starts a new renew timer while the field is undefined — without this a
        // resubscribed service would silently expire after the 1 h GENA timeout.
        if (this.sid === undefined) this.eventRenewInterval = undefined;
        return original.call(this);
    };
}

function activeServices(): Service[] {
    const registry = (SonosEventListener.DefaultInstance as unknown as { subscriptions: Record<string, Service> }).subscriptions;
    return [...new Set(Object.values(registry))];
}

const hasListeners = (s: Service): boolean => (s.events?.listenerCount(ServiceEvents.ServiceEvent) ?? 0) > 0;

async function resubscribe(services: Service[]): Promise<void> {
    await Promise.allSettled(services.map(async (s) => {
        if (s.sid !== undefined) await s.cancelSubscription().catch(() => undefined);
        if (!hasListeners(s)) return;
        await s.subscribeForEvents().catch((e) => streamDeck.logger.warn("[events] Resubscribe failed — polling covers it.", e));
    }));
}

/** Points the GENA callback at the local address in the speaker's subnet, or disables events. */
export async function applyListenerHost(speakerIp: string): Promise<void> {
    if (process.env.SONOS_LISTENER_HOST) return; // explicit override wins
    wrapSubscribe();
    const host = pickListenerHost(networkInterfaces(), speakerIp);
    const listener = SonosEventListener.DefaultInstance;
    const previousHost = listener.GetStatus().host;

    if (!host) {
        if (blocked) return;
        blocked = true;
        streamDeck.logger.warn(
            `[events] No local address in the subnet of ${speakerIp} (VPN or other network?) — ` +
            `not subscribing to UPnP events, polling only. A callback the speakers can't reach would ` +
            `delay events for every other Sonos controller.`);
        const services = activeServices();
        services.forEach((s) => parked.add(s));
        await Promise.allSettled(services.map((s) => s.cancelSubscription()));
        return;
    }

    if (!blocked && host === previousHost) return;
    const wasBlocked = blocked;
    blocked = false;
    listener.UpdateSettings({ host });
    streamDeck.logger.info(`[events] Event listener host: ${host}${previousHost !== host ? ` (was ${previousHost})` : ""}`);

    const toResubscribe = new Set<Service>(previousHost !== host ? activeServices() : []);
    if (wasBlocked) parked.forEach((s) => toResubscribe.add(s));
    parked.clear();
    if (toResubscribe.size > 0) await resubscribe([...toResubscribe]);
}

/** Re-checks the network periodically so a VPN coming up or going away is picked up. */
export function watchListenerHost(speakerIp: () => string | undefined): void {
    if (watchTimer || process.env.SONOS_LISTENER_HOST) return;
    watchTimer = setInterval(() => {
        const ip = speakerIp();
        if (ip) void applyListenerHost(ip).catch((e) => streamDeck.logger.warn("[events] Listener host check failed", e));
    }, WATCH_INTERVAL_MS);
    watchTimer.unref?.();
}

export const eventsBlocked = (): boolean => blocked;
