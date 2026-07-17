// Whole-group fade-out orchestration (fade every member in parallel, run an action, restore
// each member to ITS OWN pre-fade volume) — extracted from SonosDeviceController, which now
// only delegates. Cross-controller access goes through the narrow FadeMemberController
// interface below instead of reaching into another controller's privates.

import { sonosManager } from "./sonos-discovery";
import { withTimeout } from "../utils/with-timeout";
import { computeFadeSteps } from "../utils/volume-fade";

// Same bound as SonosDeviceController.setVolume — an unreachable member must not stall the
// whole group ramp for the OS-level TCP connect timeout.
const FADE_SET_VOLUME_TIMEOUT_MS = 5000;

// What the coordinator needs from each participating controller (structurally satisfied by
// SonosDeviceController). applyFadeVolume keeps that member's own dials animating; see its
// doc comment on the controller.
export interface FadeMemberController {
    readonly deviceIp: string;
    readonly liveVolume: number;
    applyFadeVolume(volume: number): Promise<void>;
    notifyFadeState(fading: boolean, durationMs?: number): void;
}

export class GroupFadeCoordinator {
  // Fade-before-favorite coordination: a newer fadeGroupThenRun call bumps the generation,
  // which aborts any ramp still in flight. preFadeVolumes remembers each group member's volume
  // from BEFORE the first fade started, so rapidly switching favorites mid-fade never adopts a
  // half-faded volume as the level to restore to.
  private fadeGeneration = 0;
  private preFadeVolumes: Map<string, number> = new Map();

  constructor(
    // The controller that owns this coordinator — always part of the fade group.
    private readonly self: FadeMemberController,
    private readonly getTransportState: () => Promise<string>,
    // Non-owning pooled-controller lookup (SonosDeviceManager.peekController), injected so
    // this module does not join the manager<->controller import cycle.
    private readonly peekController: (host: string) => FadeMemberController | undefined,
  ) {}

  /**
   * Fades the WHOLE group's volume to 0 in parallel, runs `action`, then restores every member to
   * ITS OWN pre-fade volume immediately afterward (no fade-in — see each caller for why that's the
   * right call for it). Falls back to running `action` directly, no fade, when nothing is audibly
   * playing (paused, or every member at volume 0) or `fadeOutMs <= 0`. Shared by `playFavoriteWithFade`
   * (below), MultiControlKey's Line-In switch, and PlayPauseToggle's fade (see feature memory).
   */
  async fadeGroupThenRun(action: () => Promise<void>, fadeOutMs: number): Promise<void> {
    const generation = ++this.fadeGeneration;
    const cancelled = () => this.fadeGeneration !== generation;

    let isPlaying = false;
    try {
      isPlaying = (await this.getTransportState()) === 'PLAYING';
    } catch { /* device didn't answer — treat as not playing and run without fade */ }

    const members = (fadeOutMs > 0 && isPlaying) ? await this.collectFadeMembers() : [];
    const audible = members.filter((m) => m.preVolume > 0);

    if (fadeOutMs <= 0 || !isPlaying || audible.length === 0) {
      await action();
      return;
    }

    // Remembered per host so a rapid follow-up press mid-fade restores each member to its
    // ORIGINAL volume, not the half-faded one it happens to be at (collectFadeMembers reads
    // this map before we replace it).
    this.preFadeVolumes = new Map(audible.map((m) => [m.host, m.preVolume]));
    // Told up front, before the first actual SetVolume goes out — see notifyFadeState's doc
    // comment for why this is a pure UI signal to whichever dial is watching each member.
    audible.forEach((m) => m.notifyFading(true, fadeOutMs));
    try {
      await Promise.allSettled(audible.map((m) => this.ramp(m.setVolume, m.liveVolume, 0, fadeOutMs, cancelled)));
      if (cancelled()) return; // a newer fade took over mid-ramp
      await action();
    } finally {
      if (!cancelled()) {
        this.preFadeVolumes.clear();
        // Restore every member to its own pre-fade volume right away — radio streams buffer for
        // a couple of seconds after Play() returns, so this lands while the group is still
        // silent and the audio then comes in at the correct level. Doubles as the error rescue.
        await Promise.allSettled(audible.map((m) => m.setVolume(m.preVolume).catch(() => {})));
        // Only the winning (non-cancelled) fade ever turns fading back off — a superseded fade
        // must NOT do this, or its own delayed cleanup could race a newer fade's notifyFading(true)
        // and turn the fake animation off while that newer fade is still actually running.
        audible.forEach((m) => m.notifyFading(false, 0));
      }
    }
  }

  // One entry per group member taking part in a fade. Volume goes through the member's pooled
  // controller when one exists — that keeps its dials animating via its volume callbacks — and
  // straight to the manager-owned device otherwise (no watchers to notify, and deliberately NOT
  // sonosDeviceManager.getController(): spinning up a full controller with poll loops and GENA
  // subscriptions per fade for a device no action is watching would be far too heavy).
  private async collectFadeMembers(): Promise<Array<{ host: string; preVolume: number; liveVolume: number; setVolume: (v: number) => Promise<void>; notifyFading: (fading: boolean, durationMs: number) => void }>> {
    let hosts: string[];
    try {
      const managed = sonosManager.Devices.find((d) => d.Host === this.self.deviceIp);
      const myCoordinatorHost = managed?.Coordinator?.Host ?? managed?.Host ?? this.self.deviceIp;
      hosts = sonosManager.Devices
        .filter((d) => (d.Coordinator?.Host ?? d.Host) === myCoordinatorHost)
        .map((d) => d.Host);
      if (!hosts.includes(this.self.deviceIp)) hosts.push(this.self.deviceIp);
    } catch {
      hosts = [this.self.deviceIp]; // discovery not ready — fade at least this device
    }

    const members: Array<{ host: string; preVolume: number; liveVolume: number; setVolume: (v: number) => Promise<void>; notifyFading: (fading: boolean, durationMs: number) => void }> = [];
    await Promise.all(hosts.map(async (host) => {
      const controller = host === this.self.deviceIp ? this.self : this.peekController(host);
      if (controller) {
        members.push({
          host,
          preVolume: this.preFadeVolumes.get(host) ?? controller.liveVolume,
          liveVolume: controller.liveVolume,
          setVolume: (v) => controller.applyFadeVolume(v),
          notifyFading: (fading, durationMs) => controller.notifyFadeState(fading, durationMs),
        });
        return;
      }
      const device = sonosManager.Devices.find((d) => d.Host === host);
      if (!device) return;
      try {
        const vol = await withTimeout(
          device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' }),
          3000,
          `fade GetVolume (${host})`,
        );
        members.push({
          host,
          preVolume: this.preFadeVolumes.get(host) ?? vol.CurrentVolume,
          liveVolume: vol.CurrentVolume,
          setVolume: async (v) => {
            await withTimeout(
              device.RenderingControlService.SetVolume({ InstanceID: 0, Channel: 'Master', DesiredVolume: v }),
              FADE_SET_VOLUME_TIMEOUT_MS,
              `fade SetVolume (${host})`,
            );
          },
          // No pooled controller ⇒ no dial is watching this device, nothing to signal.
          notifyFading: () => {},
        });
      } catch { /* member unreachable — leave it out of the fade entirely */ }
    }));
    return members;
  }

  private async ramp(setVolume: (v: number) => Promise<void>, from: number, to: number, durationMs: number, isCancelled: () => boolean): Promise<void> {
    for (const step of computeFadeSteps(from, to, durationMs)) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (isCancelled()) return;
      await setVolume(step.volume);
    }
  }
}
