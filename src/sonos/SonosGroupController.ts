import streamDeck from "@elgato/streamdeck";
import { safeDevices, discoveryPromise } from "./sonos-discovery";
import { sonosDeviceManager } from "./SonosDeviceManager";
import { SonosDeviceController } from "./SonosDeviceController";
import { VolumeInfo } from "./SonosTypes";

// How often we re-check which devices belong to the group. Sonos groups are ephemeral —
// grouping/ungrouping via the app or a coordinator reboot can change membership/coordinator at
// any time. `SonosDevice.Coordinator`/`.GroupName` on manager-owned devices are kept live via an
// internal GENA subscription, so this poll is a cheap (no network call) safety net, not the
// primary update mechanism.
const TOPOLOGY_RECHECK_MS = 20000;
// After we optimistically write a member's volume, ignore that member's own echoed feedback for
// this long — it can arrive late/out-of-order relative to a follow-up write and otherwise
// clobbers the value we just set (same race as the per-device VolumeDial, fixed the same way).
const MEMBER_FEEDBACK_SUPPRESS_MS = 800;

/**
 * Controls the volume of an entire Sonos zone group (all speakers grouped together), following
 * whichever group a given "anchor" device currently belongs to.
 *
 * Deliberately does NOT use GroupRenderingControlService's SetGroupVolume/SetRelativeGroupVolume.
 * Empirically, those calls do not preserve the balance between members the way the Sonos app's
 * own group volume slider does (e.g. a Sonos Port coordinator sitting at 50% next to satellites
 * at ~20% got dragged down toward the satellites' level). Instead, this drives each member's own
 * RenderingControlService individually (via the already-proven SonosDeviceController/
 * SonosDeviceManager) and applies the same additive delta to every member — confirmed with the
 * user via concrete numbers that this (not proportional/multiplicative scaling) matches the
 * expected group-volume feel: everyone gets louder/quieter by the same number of points.
 */
export class SonosGroupController {
  public readonly anchorIp: string;
  public groupName: string | undefined;

  private coordinatorHost: string | undefined;

  // One SonosDeviceController per group member, shared via SonosDeviceManager's refcounted cache
  // (so an individual VolumeDial pointed at the same speaker reuses the same connection).
  private memberControllers: Map<string, SonosDeviceController> = new Map();

  // Our own optimistic per-member volume tracking — NOT the member's own device-echoed value.
  // Proportional-scaling math for rapid dial rotation must not depend on a value that can lag
  // behind an UPnP echo; see MEMBER_FEEDBACK_SUPPRESS_MS.
  private memberVolumes: Map<string, number> = new Map();
  private memberSuppressUntil: Map<string, number> = new Map();

  // Best-effort cached aggregate, refreshed at init/topology-recheck and after toggleMute.
  private currentMute = false;

  private volumeCallbacks: Map<string, (volumeInfo: VolumeInfo) => void> = new Map();
  // Relayed from each member's own SonosDeviceController.notifyFadeState — the group as a whole
  // counts as "fading" while ANY member is (a group-wide fade starts/stops every member together,
  // see playFavoriteWithFade, so in practice they all flip in the same tick).
  private fadeStateCallbacks: Map<string, (fading: boolean, durationMs: number) => void> = new Map();
  private memberFading: Map<string, boolean> = new Map();
  // Last AGGREGATE value actually announced — a group-wide fade starts/ends all members in the
  // same synchronous forEach (see playFavoriteWithFade), so e.g. the end of a 3-member fade fires
  // this callback 3 times in a row (member 1 → false, member 2 → false, member 3 → false) while
  // members 2 and 3 are still momentarily "true" in between, making the aggregate flicker back to
  // true right as it was about to settle false. Deduping on the actual aggregate value fixes that.
  private lastAnnouncedFading = false;
  // Forwards the ANCHOR member's reachability (see SonosDeviceController's poll-driven detection)
  // as the group's own: the anchor is the device the user actually configured on the dial, so its
  // disappearance is what should read as "this tile's speaker is off". Other members dropping out
  // just degrades gracefully (their setVolume calls fail individually and are logged).
  private reachabilityCallbacks: Map<string, (reachable: boolean) => void> = new Map();

  private topologyTimer?: NodeJS.Timeout;
  private isInitialized = false;

  constructor(anchorIp: string) {
    this.anchorIp = anchorIp;
  }

  private get callbackId(): string { return `group-${this.anchorIp}`; }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await discoveryPromise;
    this.resolveCoordinator();
    await this.resolveMembers();
    await this.refreshMuteState();
    this.startTopologyWatch();
    this.isInitialized = true;
  }

  public destroy(): void {
    if (this.topologyTimer) clearInterval(this.topologyTimer);
    for (const [host, controller] of this.memberControllers) {
      controller.unregisterVolumeCallback(this.callbackId);
      controller.unregisterFadeStateCallback(this.callbackId);
      controller.unregisterReachabilityCallback(this.callbackId);
      sonosDeviceManager.releaseController(host);
    }
    this.memberControllers.clear();
    this.memberVolumes.clear();
    this.memberSuppressUntil.clear();
    this.memberFading.clear();
    this.lastAnnouncedFading = false;
    this.volumeCallbacks.clear();
    this.fadeStateCallbacks.clear();
    this.reachabilityCallbacks.clear();
  }

  // Returns true if the coordinator changed (caller may want to log it).
  private resolveCoordinator(): boolean {
    const anchor = safeDevices().find(d => d.Host === this.anchorIp);
    if (!anchor) return false;

    const coordinator = anchor.Coordinator ?? anchor;
    this.groupName = anchor.GroupName ?? coordinator.Name;

    const changed = this.coordinatorHost !== coordinator.Host;
    if (changed) this.coordinatorHost = coordinator.Host;
    return changed;
  }

  // Acquires a SonosDeviceController for every current group member (matched by shared
  // coordinator host), releasing any that are no longer part of the group.
  private async resolveMembers(): Promise<void> {
    if (!this.coordinatorHost) return;
    const currentHosts = new Set(
      safeDevices()
        .filter(d => (d.Coordinator ?? d).Host === this.coordinatorHost)
        .map(d => d.Host)
    );

    for (const host of [...this.memberControllers.keys()]) {
      if (currentHosts.has(host)) continue;
      this.memberControllers.get(host)?.unregisterVolumeCallback(this.callbackId);
      this.memberControllers.get(host)?.unregisterFadeStateCallback(this.callbackId);
      this.memberControllers.get(host)?.unregisterReachabilityCallback(this.callbackId);
      sonosDeviceManager.releaseController(host);
      this.memberControllers.delete(host);
      this.memberVolumes.delete(host);
      this.memberSuppressUntil.delete(host);
      this.memberFading.delete(host);
    }

    for (const host of currentHosts) {
      if (this.memberControllers.has(host)) continue;
      try {
        const controller = await sonosDeviceManager.getController(host);
        this.memberControllers.set(host, controller);
        const info = await controller.getVolume();
        this.memberVolumes.set(host, info.volume);
        controller.registerVolumeCallback(this.callbackId, (vi: VolumeInfo) => {
          if (Date.now() < (this.memberSuppressUntil.get(host) ?? 0)) return;
          this.memberVolumes.set(host, vi.volume);
          this.notifyVolumeChanged();
        });
        controller.registerFadeStateCallback(this.callbackId, (fading: boolean, durationMs: number) => {
          this.memberFading.set(host, fading);
          const anyFading = [...this.memberFading.values()].some((f) => f);
          if (anyFading === this.lastAnnouncedFading) return; // no actual change at the group level
          this.lastAnnouncedFading = anyFading;
          this.fadeStateCallbacks.forEach((cb) => cb(anyFading, durationMs));
        });
        if (host === this.anchorIp) {
          controller.registerReachabilityCallback(this.callbackId, (reachable) => {
            this.reachabilityCallbacks.forEach(cb => cb(reachable));
          });
        }
      } catch (e) {
        streamDeck.logger.error(`SonosGroupController [${this.anchorIp}]: failed to connect to member ${host}`, e);
      }
    }
  }

  private startTopologyWatch(): void {
    this.topologyTimer = setInterval(async () => {
      const coordinatorChanged = this.resolveCoordinator();
      await this.resolveMembers();
      if (coordinatorChanged) {
        streamDeck.logger.info(`SonosGroupController: coordinator for anchor ${this.anchorIp} is now ${this.coordinatorHost} ("${this.groupName}").`);
      }
      await this.refreshMuteState();
      this.notifyVolumeChanged();
    }, TOPOLOGY_RECHECK_MS);
  }

  private async refreshMuteState(): Promise<void> {
    const members = [...this.memberControllers.values()];
    if (members.length === 0) return;
    const infos = await Promise.all(members.map(c => c.getVolume()));
    this.currentMute = infos.every(i => i.mute);
  }

  private notifyVolumeChanged(): void {
    const info = this.aggregateVolume();
    this.volumeCallbacks.forEach(cb => cb(info));
  }

  private aggregateVolume(): VolumeInfo {
    const volumes = [...this.memberVolumes.values()];
    const volume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : 0;
    return { volume, mute: this.currentMute };
  }

  // --- Public API ---
  async getVolume(): Promise<VolumeInfo> {
    return this.aggregateVolume();
  }

  // Snapshot of each current group member's own volume — used to save a preset that captures
  // the whole group's balance (e.g. Port at 50%, satellites at 20%), not a single flattened
  // number. Uses the same baseline logic as adjustVolume so the snapshot reflects reality even
  // if a member was changed through another surface just before saving.
  async getMemberVolumeSnapshot(): Promise<Record<string, number>> {
    const entries = [...this.memberControllers.entries()];
    const volumes = await Promise.all(entries.map(([host, controller]) => this.getBaselineVolume(host, controller)));
    const snapshot: Record<string, number> = {};
    entries.forEach(([host], i) => { snapshot[host] = volumes[i]; });
    return snapshot;
  }

  // Restores each member's own saved volume from a snapshot. Members no longer in the group (or
  // added since the snapshot was taken) are silently skipped rather than erroring.
  async recallMemberVolumes(preset: Record<string, number>): Promise<void> {
    const entries = [...this.memberControllers.entries()].filter(([host]) => preset[host] !== undefined);
    await Promise.all(entries.map(async ([host, controller]) => {
      const target = preset[host];
      this.memberVolumes.set(host, target);
      this.memberSuppressUntil.set(host, Date.now() + MEMBER_FEEDBACK_SUPPRESS_MS);
      try {
        await controller.setVolume(target);
      } catch (e) {
        streamDeck.logger.error(`SonosGroupController [${this.anchorIp}]: failed to recall preset volume for member ${host}`, e);
      }
    }));
  }

  // Returns the volume to use as this member's baseline for scale math. While our own
  // suppression window is active, the optimistic cache is authoritative (we just wrote it, and a
  // live read risks racing that write's own echo). Once the window has lapsed, the cache may be
  // stale relative to a change made through another surface entirely (an individual VolumeDial
  // pointed at the same speaker, the physical remote, the Sonos app) — refresh from the device
  // instead of trusting a possibly-outdated number.
  private async getBaselineVolume(host: string, controller: SonosDeviceController): Promise<number> {
    if (Date.now() < (this.memberSuppressUntil.get(host) ?? 0)) {
      return this.memberVolumes.get(host) ?? 0;
    }
    try {
      const live = await controller.sonosDevice.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
      this.memberVolumes.set(host, live.CurrentVolume);
      return live.CurrentVolume;
    } catch (e) {
      streamDeck.logger.debug(`SonosGroupController [${this.anchorIp}]: live volume refresh failed for ${host}`, e);
      return this.memberVolumes.get(host) ?? 0;
    }
  }

  // Additive nudge — used for dial rotation. Every member moves by the same number of
  // percentage points, so the absolute gap between an already-louder coordinator (e.g. a Sonos
  // Port at 50% next to satellites at ~20%) and the others stays constant, and every speaker
  // becomes noticeably louder/quieter by a comparable amount. (Confirmed with the user via
  // concrete numbers 2026-07-05: Port 50%/Satellite 20%, +10 group points → Port 60%/Satellite
  // 30% — NOT a proportional/multiplicative scale, which was tried first and rejected because it
  // made the already-loud member change a lot while quiet members barely moved.)
  async adjustVolume(delta: number): Promise<void> {
    if (delta === 0) return;
    const entries = [...this.memberControllers.entries()];
    if (entries.length === 0) return;

    const oldVolumes = await Promise.all(entries.map(([host, controller]) => this.getBaselineVolume(host, controller)));

    await Promise.all(entries.map(async ([host, controller], i) => {
      const oldVol = oldVolumes[i];
      const newVol = Math.round(Math.min(100, Math.max(0, oldVol + delta)));
      if (newVol === oldVol) return;
      this.memberVolumes.set(host, newVol);
      this.memberSuppressUntil.set(host, Date.now() + MEMBER_FEEDBACK_SUPPRESS_MS);
      try {
        await controller.setVolume(newVol);
      } catch (e) {
        streamDeck.logger.error(`SonosGroupController [${this.anchorIp}]: failed to adjust volume for member ${host}`, e);
      }
    }));
  }

  async toggleMute(): Promise<boolean> {
    const entries = [...this.memberControllers.entries()];
    if (entries.length === 0) { streamDeck.logger.warn(`SonosGroupController [${this.anchorIp}]: toggleMute with no resolved members.`); return this.currentMute; }
    const infos = await Promise.all(entries.map(([, c]) => c.getVolume()));
    const newMute = !infos.every(i => i.mute);
    await Promise.all(entries.map(async ([host, controller], i) => {
      if (infos[i].mute === newMute) return;
      try {
        await controller.toggleMute();
      } catch (e) {
        streamDeck.logger.error(`SonosGroupController [${this.anchorIp}]: failed to toggle mute for member ${host}`, e);
      }
    }));
    this.currentMute = newMute;
    return newMute;
  }

  getGroupName(): string { return this.groupName ?? ''; }

  registerVolumeCallback(id: string, callback: (volumeInfo: VolumeInfo) => void): void { this.volumeCallbacks.set(id, callback); }
  unregisterVolumeCallback(id: string): void { this.volumeCallbacks.delete(id); }
  registerFadeStateCallback(id: string, callback: (fading: boolean, durationMs: number) => void): void { this.fadeStateCallbacks.set(id, callback); }
  unregisterFadeStateCallback(id: string): void { this.fadeStateCallbacks.delete(id); }
  registerReachabilityCallback(id: string, callback: (reachable: boolean) => void): void { this.reachabilityCallbacks.set(id, callback); }
  unregisterReachabilityCallback(id: string): void { this.reachabilityCallbacks.delete(id); }
}
