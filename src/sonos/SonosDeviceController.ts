import streamDeck from "@elgato/streamdeck";
import { SonosDevice, SonosEvents, ServiceEvents, MetaDataHelper } from "@svrooij/sonos";
import { sonosFavoritesCache, sonosManager } from "./sonos-discovery";

import { Track } from "@svrooij/sonos/lib/models";
import { loadImageFromUri } from "./utils";
import { normalizeBrowseResult } from "./queueUtils";
import { GetZoneAttributesResponse } from "@svrooij/sonos/lib/services";
import { SonosZoneGroupStates, TrackInfo, VolumeInfo } from "./SonosTypes";
import { withTimeout } from "../utils/fetchWithTimeout";
import { computeFadeSteps } from "../utils/volume-fade";
import { fetchBatteryStatus, SonosBatteryStatus } from "./SonosBattery";
// Lazy/deferred use only (inside methods, never at module scope) — SonosDeviceManager itself
// imports SonosDeviceController, so this is a circular import; safe here because sonosDeviceManager
// is only actually accessed later, well after both modules finish evaluating.
import { sonosDeviceManager } from "./SonosDeviceManager";

// An unreachable device's SOAP call can otherwise hang for the OS-level TCP connect timeout
// (20-30s+ on Windows) before rejecting — long enough to block an entire group volume adjustment
// (SonosGroupController.adjustVolume awaits every member's setVolume via Promise.all) and, worse,
// the calling dial's own send-throttle state, which stays "sending" until that promise settles —
// so one offline speaker froze rotation input on the whole group dial for up to ~30s. Racing
// against a short timeout here (via withTimeout) bounds that to SET_VOLUME_TIMEOUT_MS regardless
// of the underlying library/fetch call's own timeout behavior.
const SET_VOLUME_TIMEOUT_MS = 5000;

// Battery percentage/charging state changes slowly — no need for the 8s poll cadence used for
// transport/volume. Only runs at all while at least one caller (e.g. Track Dial in a non-'off'
// battery display mode) is registered; see registerBatteryCallback/unregisterBatteryCallback.
const BATTERY_POLL_MS = 15000;

// Matches the "restart current track vs. skip to previous" convention used by Spotify/iTunes/the
// Sonos app itself — none of that lives in the UPnP Previous action, which always skips straight
// to the previous track regardless of playback position.
const PREVIOUS_RESTART_THRESHOLD_SECONDS = 3;

export class SonosDeviceController {
  public readonly deviceIp: string;
  public sonosDevice: SonosDevice; 

  private volumeInfoCallbacks: Map<string, (volumeInfo: VolumeInfo) => void> = new Map();
  // Fired around a fade-out ramp (see playFavoriteWithFade) so a watching dial can fake a smooth
  // visual descent instead of hopping between the actual coarse SetVolume steps (~150ms+ apart,
  // see volume-fade.ts's MIN_STEP_INTERVAL_MS) — purely a UI signal, changes nothing about the
  // real fade mechanics. May be fired on a DIFFERENT controller instance than the one orchestrating
  // the fade — see collectFadeMembers, which calls this on each member's own pooled controller.
  private fadeStateCallbacks: Map<string, (fading: boolean, durationMs: number) => void> = new Map();
  private transportStateCallbacks: Map<string, (transportState: string) => void> = new Map();
  private playModeCallbacks: Map<string, (playMode: string) => void> = new Map();
  private trackInfoCallbacks: Map<string, (trackInfo: TrackInfo) => void> = new Map();
  private batteryCallbacks: Map<string, (battery: SonosBatteryStatus | undefined) => void> = new Map();
  private reachabilityCallbacks: Map<string, (reachable: boolean) => void> = new Map();

  // Mid-session reachability, driven by the 8s poll loop (see notePollSuccess/notePollFailure):
  // two consecutive failed polls flip to unreachable (one alone is just a transient hiccup), the
  // next successful poll flips back. Actions use the callback to swap to the speaker-off
  // placeholder while a device is down and to fully re-initialize once it returns.
  private reachable = true;
  private consecutivePollFailures = 0;
  private static readonly UNREACHABLE_AFTER_FAILURES = 2;

  private refreshInterval?: NodeJS.Timeout;
  private pollInterval?: NodeJS.Timeout;
  private batteryPollInterval?: NodeJS.Timeout;
  private lastBatteryStatus: SonosBatteryStatus | undefined;
  private hasBatteryStatus = false;
  private lastPolledTransportState = '';
  private isInitialized = false;

  // Internal state
  private currentVolume: number = 0;
  private currentMute: boolean = false;
  // Fade-before-favorite coordination: a newer playFavoriteWithFade call bumps the generation,
  // which aborts any ramp still in flight. preFadeVolumes remembers each group member's volume
  // from BEFORE the first fade started, so rapidly switching favorites mid-fade never adopts a
  // half-faded volume as the level to restore to.
  private fadeGeneration = 0;
  private preFadeVolumes: Map<string, number> = new Map();
  private currentAlbumArtUri: string = '';
  private currentTrack: TrackInfo | undefined;
  // Only ever set when a cover is successfully loaded; never cleared by track events with no art.
  private lastKnownCover: string | undefined;
  // Bounds the "still missing" cover retry in the poll loop below — without this it retried an
  // HTTP fetch every single 8s tick forever whenever a track's cover genuinely never loads (e.g.
  // a radio stream with no logo), flooding logs and network with failed requests indefinitely
  // for the lifetime of the controller. Resets when playback stops so a later track gets a fresh
  // set of attempts.
  private coverFetchAttempts = 0;
  private static readonly MAX_COVER_FETCH_ATTEMPTS = 5;

  // When grouped under a different coordinator, we forward THAT coordinator's own controller's
  // transport-state/track-info callbacks as our own instead of relying on this device's own
  // group-relayed UPnP events — confirmed on hardware those lag by ~10s behind the coordinator's
  // own (instant) events. See syncCoordinatorSubscription().
  private coordinatorController?: SonosDeviceController;
  private subscribedCoordinatorHost?: string;
  private get coordinatorCallbackId(): string { return `member-${this.deviceIp}`; }

  private static isRadioAlbumArtUri(albumArtUri: string | undefined): boolean {
    if (!albumArtUri) return false;
    // Sonos Radio (Deezer-powered) serves cover art from sonosradio.imgix.net — no u= parameter.
    if (albumArtUri.includes('sonosradio.imgix.net')) return true;
    const match = albumArtUri.match(/[?&]u=([^&]+)/);
    if (!match) return false;
    return MetaDataHelper.IsRadioStream(decodeURIComponent(match[1]));
  }

  // Sonos' own TuneIn-logo resize proxy (e.g. https://sali.sonos.superhi.fi/image?w=60&image=
  // <original-logo-url>&partnerId=tunein, surfaced via GetMediaInfo's CurrentURIMetaData for
  // stations with no useful GetPositionInfo metadata) defaults to a tiny width — 60px, meant for
  // a small list-row icon — which looks visibly pixelated stretched across the much larger Track
  // Dial cover area. Bump the requested width up via the same proxy rather than fetching the
  // (potentially much larger/wrong-format) original directly.
  private static upsizeSonosImageProxyUrl(url: string): string {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('sonos.superhi.fi') || !u.searchParams.has('w')) return url;
      u.searchParams.set('w', '300');
      return u.toString();
    } catch {
      return url;
    }
  }

  // Detects a "Title" that's actually just the trailing filename/query segment of a raw stream
  // URL — Sonos' own fallback when a station provides no real metadata in GetPositionInfo (e.g.
  // "stream.mp3?aggregator=tunein&cid=..."). Confirmed on hardware for a WDR2/TuneIn stream; used
  // to prefer GetMediaInfo's CurrentURIMetaData (the real station name) instead — see
  // getCurrentTrack().
  private static looksLikeRawStreamFilename(title: string | undefined): boolean {
    if (!title) return false;
    return /\.(mp3|aac|m4a|ogg|flac|wav|m3u8?|pls)(\?|$)/i.test(title);
  }

  constructor(deviceIp: string) {
    this.deviceIp = deviceIp;
    this.sonosDevice = new SonosDevice(deviceIp);
    streamDeck.logger.debug(`SonosDeviceController for ${this.deviceIp} created.`);
  }

  // loadImageFromUri (src/sonos/utils.ts) itself dedupes concurrent fetches and caches resolved
  // covers by URL, and bounds each fetch with a real (abort-based) timeout — shared across every
  // caller, not just this one. This wrapper just adapts its "" (no cover) return to `undefined`.
  private async resolveCoverArt(uri: string): Promise<string | undefined> {
    const cover = await loadImageFromUri(uri, this.transportDevice).catch(() => '');
    return cover || undefined;
  }

  // The device to query for transport state / current track / position / cover art. A grouped,
  // non-coordinator member's OWN AVTransportService reports stale/wrong data (confirmed on real
  // hardware: a grouped Roam's GetTransportInfo said PLAYING while the group's actual coordinator
  // correctly said STOPPED) — only the group COORDINATOR's AVTransportService is authoritative.
  // `this.sonosDevice` is a bare `new SonosDevice(ip)`, which never gets a populated `.Coordinator`
  // of its own (that's only wired up by SonosManager's zone-topology GENA subscription onto the
  // devices it discovers) — so resolve via the manager-owned counterpart in `sonosManager.Devices`
  // instead, exactly like SonosGroupController.resolveCoordinator() already does. Looked up fresh
  // on every access rather than cached: `.Coordinator` is kept live by that same subscription (no
  // polling needed for it specifically), and groups can reform at any time. Falls back to
  // `this.sonosDevice` if discovery hasn't completed yet or the device isn't found — same as an
  // ungrouped/standalone device.
  //
  // Deliberately does NOT change volume/mute (RenderingControlService) or playback commands
  // (Play/Pause/Next/Previous) — those already work correctly sent directly to the member (Sonos
  // forwards them internally), and per-member volume is intentionally individual even within a
  // group (see SonosGroupController, which exists specifically to aggregate that).
  public get transportDevice(): SonosDevice {
    try {
      const managed = sonosManager.Devices.find(d => d.Host === this.deviceIp);
      return managed?.Coordinator ?? this.sonosDevice;
    } catch {
      return this.sonosDevice;
    }
  }

  // True only when transportDevice actually resolved to a genuinely different physical device
  // (the group coordinator) — false for a standalone device or one that IS the coordinator, even
  // though transportDevice returns a different SonosDevice *object* in that case too (the
  // manager-owned instance, not this.sonosDevice) since object identity isn't a reliable signal
  // here, only the host is.
  private get isGroupedMember(): boolean {
    return this.transportDevice.Host !== this.deviceIp;
  }

  // Keeps our forwarded coordinator subscription pointed at whichever device is currently the
  // group coordinator (re-checked every poll tick since groups can reform at any time — cheap,
  // no network call, just local sonosManager.Devices/.Coordinator reads via transportDevice).
  // Acquires a full SonosDeviceController for the coordinator via the same refcounted pool every
  // other action uses, and forwards ITS already-correct-and-fast transport-state/track-info
  // callbacks as our own — instead of this device's own group-relayed events/polling, which are
  // both far slower (confirmed on hardware: ~10s vs. instant on the coordinator itself).
  private async syncCoordinatorSubscription(): Promise<void> {
    const coordinatorHost = this.isGroupedMember ? this.transportDevice.Host : undefined;

    if (this.subscribedCoordinatorHost === coordinatorHost) return; // nothing changed

    if (this.coordinatorController) {
      this.coordinatorController.unregisterTransportStateCallback(this.coordinatorCallbackId);
      this.coordinatorController.unregisterTrackInfoCallback(this.coordinatorCallbackId);
      sonosDeviceManager.releaseController(this.coordinatorController.deviceIp);
      this.coordinatorController = undefined;
    }
    this.subscribedCoordinatorHost = coordinatorHost;

    if (!coordinatorHost) return; // no longer grouped (or discovery not ready) — plain self-polling is correct again

    try {
      const controller = await sonosDeviceManager.getController(coordinatorHost);
      // A concurrent re-check may have already moved on to a different (or no) coordinator while
      // this getController() call was in flight — don't clobber that newer state.
      if (this.subscribedCoordinatorHost !== coordinatorHost) {
        sonosDeviceManager.releaseController(coordinatorHost);
        return;
      }
      this.coordinatorController = controller;
      streamDeck.logger.info(`[${this.deviceIp}] Subscribed to coordinator ${coordinatorHost} for transport/track updates.`);
      // Both forwards are gated on this device's own reachability: the coordinator keeps living
      // (and firing) while a grouped member is powered off, and letting its track/cover updates
      // through would repaint a tile that is deliberately showing the speaker-off placeholder.
      controller.registerTransportStateCallback(this.coordinatorCallbackId, (ts) => {
        if (!this.reachable) return;
        streamDeck.logger.debug(`[${this.deviceIp}] Forwarded transport state from coordinator ${coordinatorHost}: ${ts}`);
        if (ts !== this.lastPolledTransportState) {
          this.lastPolledTransportState = ts;
          this.transportStateCallbacks.forEach(cb => cb(ts));
        }
      });
      controller.registerTrackInfoCallback(this.coordinatorCallbackId, (ti) => {
        if (!this.reachable) return;
        streamDeck.logger.info(`[${this.deviceIp}] Forwarded track info from coordinator ${coordinatorHost}: Title="${ti?.Title}", hasArt=${!!ti?.albumArtDataUri}`);
        this.currentTrack = ti;
        this.trackInfoCallbacks.forEach(cb => cb(ti));
      });
    } catch (e) {
      streamDeck.logger.warn(`[${this.deviceIp}] Failed to subscribe to coordinator ${coordinatorHost}`, e);
      this.subscribedCoordinatorHost = undefined;
    }
  }

  // --- Init & Destroy ---
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    await this.updateInitialState();
    await this.initializeSubscriptions();
    await this.syncCoordinatorSubscription();
    // Always poll — catches missed UPnP events (e.g. lost PLAYING after TRANSITIONING).
    this.startPolling();
    this.startRefreshEventSubscriptions();
    this.isInitialized = true;
  }
  public destroy(): void {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.batteryPollInterval) clearInterval(this.batteryPollInterval);
    this.cancelSubscriptions();
    if (this.coordinatorController) {
      this.coordinatorController.unregisterTransportStateCallback(this.coordinatorCallbackId);
      this.coordinatorController.unregisterTrackInfoCallback(this.coordinatorCallbackId);
      sonosDeviceManager.releaseController(this.coordinatorController.deviceIp);
      this.coordinatorController = undefined;
    }
    this.volumeInfoCallbacks.clear();
    this.transportStateCallbacks.clear();
    this.playModeCallbacks.clear();
    this.trackInfoCallbacks.clear();
    this.batteryCallbacks.clear();
    this.reachabilityCallbacks.clear();
  }

  private startPolling(): void {
    if (this.pollInterval) return;
    let trackPollTick = 0;
    this.pollInterval = setInterval(async () => {
      try {
        await this.syncCoordinatorSubscription();

        const [tsInfo, volInfo, muteInfo] = await Promise.all([
          this.transportDevice.AVTransportService.GetTransportInfo({ InstanceID: 0 }),
          this.sonosDevice.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' }),
          this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' }),
        ]);
        // The device itself answered (GetVolume/GetMute target it directly, even when grouped).
        this.notePollSuccess();

        const ts = tsInfo.CurrentTransportState;
        if (ts !== this.lastPolledTransportState) {
          this.lastPolledTransportState = ts;
          this.transportStateCallbacks.forEach(cb => cb(ts));
          // Give a later (possibly different) track a fresh set of cover-fetch attempts.
          if (ts !== 'PLAYING') this.coverFetchAttempts = 0;
        }

        const newVol = volInfo.CurrentVolume;
        const newMute = muteInfo.CurrentMute;
        if (newVol !== this.currentVolume || newMute !== this.currentMute) {
          this.currentVolume = newVol;
          this.currentMute = newMute;
          this.volumeInfoCallbacks.forEach(cb => cb({ volume: newVol, mute: newMute }));
        }

        // Re-fetch cover while playing if it's missing (e.g. device was not yet online after
        // standby) OR stale — stale meaning the current track declares an AlbumArtUri that was
        // never successfully resolved (its event-time fetch failed or its resolved cover got
        // dropped by a racing track update). Self-heals within one 8s tick instead of showing
        // the previous track's art until the next track change. Bounded — see coverFetchAttempts
        // comment above; the currentTrack event handler resets the counter per track.
        const wantedArtUri = this.currentTrack?.AlbumArtUri;
        const coverMissingOrStale = !this.lastKnownCover || (!!wantedArtUri && wantedArtUri !== this.currentAlbumArtUri);
        if (ts === 'PLAYING' && coverMissingOrStale && this.coverFetchAttempts < SonosDeviceController.MAX_COVER_FETCH_ATTEMPTS) {
          this.coverFetchAttempts++;
          const cover = wantedArtUri
            ? await this.resolveCoverArt(wantedArtUri)
            : await this.getCurrentTrackCover().catch(() => undefined);
          if (cover) {
            this.lastKnownCover = cover;
            if (wantedArtUri) this.currentAlbumArtUri = wantedArtUri;
            this.coverFetchAttempts = 0;
            if (!this.currentTrack) this.currentTrack = { albumArtDataUri: cover } as TrackInfo;
            else this.currentTrack.albumArtDataUri = cover;
            this.trackInfoCallbacks.forEach(cb => cb(this.currentTrack!));
          }
        }

        // Poll track info every 3rd tick (~24 s) when playing — covers UPnP-dead scenarios.
        trackPollTick++;
        if (trackPollTick % 3 === 0 && ts === 'PLAYING') {
          const track = await this.getCurrentTrack();
          if (track && track.Title !== this.currentTrack?.Title) {
            const newTrackInfo: TrackInfo = { ...track };
            if (track.AlbumArtUri && track.AlbumArtUri !== this.currentAlbumArtUri) {
              this.currentAlbumArtUri = track.AlbumArtUri;
              try {
                const cover = await loadImageFromUri(track.AlbumArtUri, this.transportDevice);
                if (cover) { newTrackInfo.albumArtDataUri = cover; this.lastKnownCover = cover; }
              } catch { this.currentAlbumArtUri = ''; }
            }
            newTrackInfo.albumArtDataUri = newTrackInfo.albumArtDataUri ?? this.lastKnownCover;
            newTrackInfo.isRadio =
              MetaDataHelper.IsRadioStream(track.TrackUri) ||
              (track.AlbumArtUri
                ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri)
                : (this.currentTrack?.isRadio ?? false));
            this.currentTrack = newTrackInfo;
            this.trackInfoCallbacks.forEach(cb => cb(this.currentTrack!));
          }
        }
      } catch (e) {
        streamDeck.logger.debug(`[${this.deviceIp}] Polling error:`, e);
        this.notePollFailure();
      }
    }, 8000);
  }

  private async updateInitialState(): Promise<void> {
    const volume = await this.sonosDevice.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
    this.currentVolume = volume.CurrentVolume;

    const mute = await this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' });
    this.currentMute = mute.CurrentMute;

    const track = await this.getCurrentTrack();
    if (track) {
        this.currentTrack = track;
        this.currentTrack.isRadio =
            MetaDataHelper.IsRadioStream(track.TrackUri) ||
            (track.AlbumArtUri ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri) : false);
        if (track.AlbumArtUri) {
            const cover = await loadImageFromUri(track.AlbumArtUri, this.transportDevice);
            if (cover) {
                this.currentTrack.albumArtDataUri = cover;
                this.lastKnownCover = cover;
                // Mark as resolved so the poll's stale-cover check doesn't re-fetch it right away.
                this.currentAlbumArtUri = track.AlbumArtUri;
            }
        }
    }

    // For radio streams getCurrentTrack() returns undefined (string metadata).
    // Fetch cover via /getaa so the station logo shows immediately after restart.
    if (!this.lastKnownCover) {
        const cover = await this.getCurrentTrackCover().catch(() => undefined);
        if (cover) {
            if (!this.currentTrack) this.currentTrack = { albumArtDataUri: cover } as TrackInfo;
            else this.currentTrack.albumArtDataUri = cover;
            this.lastKnownCover = cover;
        }
    }
  }

  // --- Basic Controls ---
  // Must await (not fire-and-forget) — a rejected, un-awaited promise here becomes an unhandled
  // rejection that crashes the whole plugin process (every device/action, not just this one),
  // exactly as `next()`/`previous()` did before their call sites gained try/catch (e.g. a "Next"
  // on a source that doesn't support skipping throws UPnPError 701 "Transition not available").
  //
  // Target transportDevice (the group coordinator when grouped), not this.sonosDevice — confirmed
  // on hardware that a non-coordinator member's own transport does NOT reliably forward Next
  // (Sonos does not always relay these internally, contrary to earlier assumption); Seek already
  // used transportDevice and worked correctly for a grouped member, which is what exposed this.
  async togglePlayPause(): Promise<void> { await this.transportDevice.TogglePlayback(); }
  async next(): Promise<void> { await this.transportDevice.Next(); }

  // If we're more than a few seconds into the current track, restart it instead of skipping to
  // the actual previous track (standard media-player UX). GetPositionInfo throws for sources that
  // don't report a position (e.g. some radio streams) — fall through to plain Previous() then.
  async previous(): Promise<void> {
    try {
      const positionInfo = await this.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
      const elapsedSeconds = this.parseRelTime(positionInfo.RelTime);
      if (elapsedSeconds > PREVIOUS_RESTART_THRESHOLD_SECONDS) {
        await this.transportDevice.AVTransportService.Seek({ InstanceID: 0, Unit: 'REL_TIME', Target: '0:00:00' });
        return;
      }
    } catch { /* fall through to native previous */ }
    await this.transportDevice.Previous();
  }

  private parseRelTime(t: string): number {
    if (!t || t === 'NOT_IMPLEMENTED') return 0;
    const parts = t.split(':').map(Number);
    return (parts.length === 3 && parts.every(n => !isNaN(n)))
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : 0;
  }

  async setVolume(volume: number): Promise<void> {
    await withTimeout(
      this.sonosDevice.RenderingControlService.SetVolume({ DesiredVolume: volume, InstanceID: 0, Channel: "Master" }),
      SET_VOLUME_TIMEOUT_MS,
      `setVolume (${this.deviceIp})`,
    );
  }

  async volumeUp(step: number = 2): Promise<void> {
    const newVolume = Math.min(100, this.currentVolume + step);
    await this.setVolume(newVolume);
  }
  
  async volumeDown(step: number = 2): Promise<void> {
    const newVolume = Math.max(0, this.currentVolume - step);
    await this.setVolume(newVolume);
  }

  async toggleShuffle(): Promise<void> {
    const { PlayMode: currentMode } = await this.transportDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    const mode = String(currentMode);
    let desiredNext: string;

    switch (mode) {
      case 'NORMAL':
        desiredNext = 'SHUFFLE_NOREPEAT';
        break;
      case 'REPEAT_ALL':
        desiredNext = 'SHUFFLE';
        break;
      case 'REPEAT_ONE':
        desiredNext = 'SHUFFLE_REPEAT_ONE';
        break;
      case 'SHUFFLE_NOREPEAT':
        desiredNext = 'NORMAL';
        break;
      case 'SHUFFLE':
      case 'SHUFFLE_REPEAT_ALL':
        desiredNext = 'REPEAT_ALL';
        break;
      case 'SHUFFLE_REPEAT_ONE':
        desiredNext = 'REPEAT_ONE';
        break;
      default:
        desiredNext = 'SHUFFLE_NOREPEAT';
    }

    const candidates: string[] = [desiredNext];
    if (desiredNext.includes('SHUFFLE') && desiredNext !== 'SHUFFLE_NOREPEAT') {
        candidates.push('SHUFFLE_NOREPEAT');
    }
    if (!desiredNext.includes('SHUFFLE') && desiredNext !== 'NORMAL') {
        candidates.push('NORMAL');
    }

    streamDeck.logger.debug(`[toggleShuffle] current=${mode}, desiredNext=${desiredNext}, candidates=${candidates.join(',')}`);

    let lastError: any = null;
    for (const candidate of candidates) {
      try {
        await this.transportDevice.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: candidate as any });
        streamDeck.logger.info(`[toggleShuffle] SetPlayMode succeeded: ${candidate}`);
        try {
            const actual = await this.getPlayMode();
            this.playModeCallbacks.forEach(cb => cb(actual));
        } catch {
            this.playModeCallbacks.forEach(cb => cb(candidate));
        }
        return;
      } catch (err) {
        lastError = err;
        streamDeck.logger.warn(`[toggleShuffle] SetPlayMode ${candidate} failed:`, err);
        continue;
      }
    }
    streamDeck.logger.error('[toggleShuffle] All candidate play modes failed', lastError);
    throw lastError;
  }

  async toggleRepeat(): Promise<void> {
    const { PlayMode: currentMode } = await this.transportDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    const mode = String(currentMode);

    // Determine the desired next mode in a predictable rotation
    let desiredNext: string;
    switch (mode) {
      case 'NORMAL':
        desiredNext = 'REPEAT_ALL';
        break;
      case 'REPEAT_ALL':
        desiredNext = 'REPEAT_ONE';
        break;
      case 'REPEAT_ONE':
        desiredNext = 'NORMAL';
        break;
      case 'SHUFFLE_NOREPEAT':
        desiredNext = 'SHUFFLE';
        break;
      case 'SHUFFLE':
      case 'SHUFFLE_REPEAT_ALL':
        desiredNext = 'SHUFFLE_REPEAT_ONE';
        break;
      case 'SHUFFLE_REPEAT_ONE':
        desiredNext = 'SHUFFLE_NOREPEAT';
        break;
      default:
        desiredNext = 'REPEAT_ALL';
    }

    // Build fallback list: try desiredNext first, then reasonable fallbacks
    const candidates: string[] = [desiredNext];
    // If user toggles to a shuffle variant but device doesn't support, allow falling back
    if (desiredNext.includes('SHUFFLE')) {
      let normalEquivalent = desiredNext === 'SHUFFLE' ? 'REPEAT_ALL' : desiredNext.replace('SHUFFLE_', '');
      if (normalEquivalent === 'NOREPEAT') normalEquivalent = 'NORMAL';
      candidates.push(normalEquivalent);
      // also try other repeat modes
      candidates.push('REPEAT_ONE', 'REPEAT_ALL', 'NORMAL');
    } else {
      // Non-shuffle desired: also try other repeat states
      candidates.push('REPEAT_ONE', 'REPEAT_ALL', 'NORMAL');
      // also try shuffle equivalents
      candidates.push('SHUFFLE_NOREPEAT', 'SHUFFLE_REPEAT_ALL', 'SHUFFLE_REPEAT_ONE');
    }

    streamDeck.logger.debug(`[toggleRepeat] current=${mode}, desiredNext=${desiredNext}, candidates=${candidates.join(',')}`);

    let lastError: any = null;
    for (const candidate of candidates) {
      try {
        await this.transportDevice.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: candidate as any });
        streamDeck.logger.info(`[toggleRepeat] SetPlayMode succeeded: ${candidate}`);
        try {
          const actual = await this.getPlayMode();
          streamDeck.logger.debug(`[toggleRepeat] Device returned playMode=${actual}`);
          this.playModeCallbacks.forEach(cb => cb(actual));
        } catch (e) {
          streamDeck.logger.warn('[toggleRepeat] Failed to read back playMode, using candidate for UI', e);
          this.playModeCallbacks.forEach(cb => cb(candidate));
        }
        return;
      } catch (err) {
        lastError = err;
        streamDeck.logger.warn(`[toggleRepeat] SetPlayMode ${candidate} failed, trying next:`, (err && (err as any).message) ?? err);
        continue;
      }
    }

    streamDeck.logger.error('[toggleRepeat] All candidate play modes failed', lastError);
    throw lastError;
  }

  async toggleMute(): Promise<boolean> {
    const newMute = !this.currentMute;
    await this.sonosDevice.RenderingControlService.SetMute({ DesiredMute: newMute, InstanceID: 0, Channel: "Master" });
    return newMute;
  }
  
  async getVolume(): Promise<VolumeInfo> {
    return { volume: this.currentVolume, mute: this.currentMute };
  }

  // --- Getters ---
  async getTransportState(): Promise<string> {
    const transportInfo = await this.transportDevice.AVTransportService.GetTransportInfo({ InstanceID: 0 });
    return transportInfo.CurrentTransportState;
  }
  async getPlayMode(): Promise<string> {
    const settings = await this.transportDevice.AVTransportService.GetTransportSettings({ InstanceID: 0 });
    return settings.PlayMode;
  }
  async isMuted(): Promise<boolean> {
    const mute = await this.sonosDevice.RenderingControlService.GetMute({ InstanceID: 0, Channel: "Master" });
    return mute.CurrentMute;
  }

  // --- Callbacks ---
  registerVolumeCallback(id: string, callback: (volumeInfo: VolumeInfo) => void): void { this.volumeInfoCallbacks.set(id, callback); }
  unregisterVolumeCallback(id: string): void { this.volumeInfoCallbacks.delete(id); }
  registerFadeStateCallback(id: string, callback: (fading: boolean, durationMs: number) => void): void { this.fadeStateCallbacks.set(id, callback); }
  unregisterFadeStateCallback(id: string): void { this.fadeStateCallbacks.delete(id); }
  notifyFadeState(fading: boolean, durationMs = 0): void { this.fadeStateCallbacks.forEach(cb => cb(fading, durationMs)); }
  registerTransportStateCallback(id: string, callback: (transportState: string) => void): void { this.transportStateCallbacks.set(id, callback); }
  unregisterTransportStateCallback(id: string): void { this.transportStateCallbacks.delete(id); }
  registerPlayModeCallback(id: string, callback: (playMode: string) => void): void { this.playModeCallbacks.set(id, callback); }
  unregisterPlayModeCallback(id: string): void { this.playModeCallbacks.delete(id); }
  registerTrackInfoCallback(id: string, callback: (trackInfo: TrackInfo) => void): void {
    this.trackInfoCallbacks.set(id, callback);
    // Fire immediately with cached state so callers get isRadio without waiting for the next UPnP event.
    if (this.currentTrack) callback(this.currentTrack);
  }
  unregisterTrackInfoCallback(id: string): void { this.trackInfoCallbacks.delete(id); }
  registerReachabilityCallback(id: string, callback: (reachable: boolean) => void): void { this.reachabilityCallbacks.set(id, callback); }
  unregisterReachabilityCallback(id: string): void { this.reachabilityCallbacks.delete(id); }

  private notePollSuccess(): void {
    this.consecutivePollFailures = 0;
    if (!this.reachable) {
      this.reachable = true;
      streamDeck.logger.info(`[${this.deviceIp}] Device reachable again.`);
      this.reachabilityCallbacks.forEach(cb => cb(true));
    }
  }

  private notePollFailure(): void {
    this.consecutivePollFailures++;
    if (this.reachable && this.consecutivePollFailures >= SonosDeviceController.UNREACHABLE_AFTER_FAILURES) {
      this.reachable = false;
      streamDeck.logger.warn(`[${this.deviceIp}] Device unreachable (${this.consecutivePollFailures} consecutive poll failures).`);
      this.reachabilityCallbacks.forEach(cb => cb(false));
    }
  }

  // Battery polling is opt-in and started/stopped on demand (most Sonos speakers are mains-powered
  // and have no battery to report) — only runs while at least one caller is registered.
  registerBatteryCallback(id: string, callback: (battery: SonosBatteryStatus | undefined) => void): void {
    this.batteryCallbacks.set(id, callback);
    if (!this.batteryPollInterval) {
      this.batteryPollInterval = setInterval(() => { void this.pollBatteryStatus(); }, BATTERY_POLL_MS);
      void this.pollBatteryStatus();
    } else if (this.hasBatteryStatus) {
      callback(this.lastBatteryStatus);
    }
  }
  unregisterBatteryCallback(id: string): void {
    this.batteryCallbacks.delete(id);
    if (this.batteryCallbacks.size === 0 && this.batteryPollInterval) {
      clearInterval(this.batteryPollInterval);
      this.batteryPollInterval = undefined;
      this.hasBatteryStatus = false;
    }
  }
  private async pollBatteryStatus(): Promise<void> {
    const status = await fetchBatteryStatus(this.sonosDevice, this.deviceIp);
    const prevKey = this.hasBatteryStatus ? JSON.stringify(this.lastBatteryStatus) : undefined;
    this.hasBatteryStatus = true;
    if (prevKey === JSON.stringify(status)) return;
    this.lastBatteryStatus = status;
    this.batteryCallbacks.forEach(cb => cb(status));
  }

  // --- Subscriptions ---
  // The lib's public teardown (CancelEvents → service removeListener hooks) fires its GENA
  // UNSUBSCRIBE calls fire-and-forget AND only covers the device-level synthesized events — the
  // direct AVTransport/RenderingControl service listeners from initializeSubscriptions kept
  // their speaker-side subscriptions (and 10-min renew timers) alive past destroy(). Cancel each
  // service's subscription directly instead: awaitable (needed inside the ~600ms grace window
  // Stream Deck grants before force-killing the process — see graceful-shutdown.ts), covers both
  // listener styles, and no-ops for a service that was never subscribed. cancelSubscription is
  // typed private in the lib but is a plain method at runtime, hence the cast.
  async cancelSubscriptions(): Promise<void> {
    const services = [
      this.sonosDevice.AVTransportService,
      this.sonosDevice.RenderingControlService,
    ] as unknown as Array<{ cancelSubscription(): Promise<boolean> }>;
    await Promise.allSettled(services.map((s) => s.cancelSubscription()));
  }
  
  async initializeSubscriptions(): Promise<void> {
    try {
      this.sonosDevice.Events.on(SonosEvents.SubscriptionError, (err) => {
        streamDeck.logger.error("Subscribe error", err);
        if (!this.pollInterval) {
          streamDeck.logger.warn(`[${this.deviceIp}] UPnP subscription failed — falling back to 5s polling.`);
          this.startPolling();
        }
      });
      
      this.sonosDevice.AVTransportService.Events.on(ServiceEvents.ServiceEvent, (data: any) => {
          try {
            const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : String(data);
            streamDeck.logger.debug(`[AVTransportService Event] keys=${keys}`);
          } catch { /* ignore logging errors */ }
          // A grouped non-coordinator member's own transport-state events are unreliable
          // (confirmed on hardware: kept reporting PLAYING for a while after the group was
          // actually paused) — ignore them here and let the 8s poll (which reads from the
          // coordinator, see transportDevice) be the sole source of truth instead. Without this,
          // a stale member-sourced event arriving between poll ticks kept flipping the dial back
          // to "playing" (e.g. the EQ visualizer), fighting the poll's correct value.
          if (this.isGroupedMember) return;
          if (typeof data.TransportState === 'string') this.transportStateCallbacks.forEach(cb => cb(data.TransportState));
          if (typeof data.CurrentPlayMode === 'string') this.playModeCallbacks.forEach(cb => cb(data.CurrentPlayMode));
          // Some devices may emit 'PlayMode' instead of 'CurrentPlayMode'
          if (typeof data.PlayMode === 'string') this.playModeCallbacks.forEach(cb => cb(data.PlayMode));
      });
      
      this.sonosDevice.RenderingControlService.Events.on(ServiceEvents.ServiceEvent, (data: any) => {
          let stateChanged = false;
          if (data.Volume && typeof data.Volume.Master === 'number' && data.Volume.Master !== this.currentVolume) {
              this.currentVolume = data.Volume.Master;
              stateChanged = true;
          }
          if (data.Mute && typeof data.Mute.Master === 'boolean' && data.Mute.Master !== this.currentMute) {
              this.currentMute = data.Mute.Master;
              stateChanged = true;
          }

          if (stateChanged) {
              this.volumeInfoCallbacks.forEach(cb => cb({ volume: this.currentVolume, mute: this.currentMute }));
          }
      });

      this.sonosDevice.Events.on('currentTrack', (track: Track) => {
        // Unlike raw transport-state (confirmed broken for a grouped non-coordinator member — see
        // the AVTransportService listener above), svrooij's synthesized 'currentTrack' event
        // apparently DOES track the coordinator's queue correctly even for a member — suppressing
        // it here too (as an earlier version of this fix did) left track/cover changes to only be
        // caught by the slow ~24s track-info poll, making normal queue playback feel very laggy.
        // Keep this one event-driven for all devices.
        //
        // Deliberately NOT async/awaiting the cover fetch here (confirmed on hardware this was a
        // real problem): Sonos's own art proxy occasionally takes several seconds to resolve
        // (itself fetching from the streaming service, e.g. Spotify, on a cache miss), and every
        // dial/key watching this device — including ones with nothing to do with cover art, like
        // the Play/Pause key's title — sat frozen on the OLD track until that one fetch finished.
        // Fire immediately with title/artist/isRadio (all synchronous, from `track` itself) plus
        // a fallback cover, then fire AGAIN once the real cover resolves in the background.
        const previousTrack = this.currentTrack;
        const newTrackInfo: TrackInfo = track;
        newTrackInfo.albumArtDataUri = previousTrack?.albumArtDataUri || this.lastKnownCover;
        // Preserve isRadio across news segments (which fire with no AlbumArtUri).
        // TrackUri is the primary signal (always carries the radio stream scheme).
        // Fall back to AlbumArtUri-based detection, then preserve previous state for news segments.
        newTrackInfo.isRadio =
            MetaDataHelper.IsRadioStream(track.TrackUri) ||
            (track.AlbumArtUri
                ? SonosDeviceController.isRadioAlbumArtUri(track.AlbumArtUri)
                : (previousTrack?.isRadio ?? false));

        this.currentTrack = newTrackInfo;
        // A fresh track gets a fresh set of heal attempts (see the poll loop's stale-cover check).
        this.coverFetchAttempts = 0;
        this.trackInfoCallbacks.forEach(cb => cb(newTrackInfo));

        if (!track.AlbumArtUri) {
            this.currentAlbumArtUri = '';
            return;
        }

        // Resolve via transportDevice, not this.sonosDevice: a relative AlbumArtUri from the
        // coordinator's queue must be fetched from the coordinator's own host. Always goes
        // through resolveCoverArt (not gated on "URI changed since last time") — Sonos can fire
        // two overlapping currentTrack events for one track change, and deduping there (rather
        // than skipping the second call here) means both end up with the correct cover instead of
        // the second one racing ahead with the previous track's art.
        void this.resolveCoverArt(track.AlbumArtUri).then(cover => {
            // Apply to whatever object is current NOW, matched by art URI rather than object
            // identity: duplicate events, coordinator forwards (grouped members) and the track
            // poll all replace this.currentTrack with a NEW object for the SAME track, and an
            // identity check here silently dropped the resolved cover in all of those cases
            // (observed as covers arriving only via the 24s poll, or sticking until the next
            // track). The title match keeps the cover when an art-less follow-up event for the
            // same track (radio news segments) already cleared AlbumArtUri.
            const current = this.currentTrack;
            const stillWanted = !!current && (
                current.AlbumArtUri === track.AlbumArtUri ||
                (!current.AlbumArtUri && current.Title === track.Title)
            );
            if (!cover || !stillWanted) return;
            current!.albumArtDataUri = cover;
            this.lastKnownCover = cover;
            this.currentAlbumArtUri = track.AlbumArtUri!;
            this.trackInfoCallbacks.forEach(cb => cb(current!));
        }).catch(err => streamDeck.logger.error("Error loading cover art", err));
      });

      // Warm the shared cover cache (loadImageFromUri's resolvedCache) for the queue's NEXT track
      // while the current one still plays — by the time the track actually changes, the
      // currentTrack handler's resolve above is a cache hit and the "real cover" second fire
      // happens near-instantly instead of after the 2-3s the Sonos art proxy needs on a cache
      // miss. Radio streams carry no next-track metadata, so this never fires for them (their
      // station logo URL is stable and cached after the first load anyway). The lib only emits
      // this when NextTrackURI actually changed, so it's one throttled, deduped fetch per queue
      // advance — and it overlaps for free with Queue Dial's own ±2 neighbor prefetch, since both
      // share the same URL-keyed cache/dedup.
      this.sonosDevice.Events.on(SonosEvents.NextTrackMetadata, (next: Track) => {
        if (next?.AlbumArtUri) void this.resolveCoverArt(next.AlbumArtUri);
      });
    } catch (error) { streamDeck.logger.error("Error initializing subscriptions", error); }
  }
  
  private startRefreshEventSubscriptions(): void {
    this.refreshInterval = setInterval(async () => {
      try { await this.sonosDevice.RefreshEventSubscriptions(); } catch (e) { streamDeck.logger.error(`Error refreshing Sonos event subscriptions:`, e); }
    }, 300 * 1000);
  }
  
  // The rest of the methods (playFavorite, helpers, etc.) are omitted for brevity but remain unchanged.
  // ...
  // --- Helper Methods ---
  private encodeXml(str: string): string {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  
  private decodeXmlEntities(str: string): string {
    if (typeof str !== 'string') return '';
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  private generateMetadata(title: string, uri: string, upnpClass: string, protocolInfo: string): string {
    // ID -1 signals Sonos that this is a new item to add to the queue.
    return '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
        `<item id="-1" parentID="-1" restricted="true">` +
        `<dc:title>${this.encodeXml(title)}</dc:title>` +
        `<upnp:class>${upnpClass}</upnp:class>` +
        `<res protocolInfo="${protocolInfo}">${this.encodeXml(uri)}</res>` +
        `</item></DIDL-Lite>`;
  }

  private async handleLocalFolder(favorite: any): Promise<boolean> {
      const logPrefix = `[LocalFolder]`;
      streamDeck.logger.info(`${logPrefix} Browsing folder content...`);

      try {
          let result: any = null;
          
          try {
             result = await this.sonosDevice.ContentDirectoryService.Browse({
                ObjectID: favorite.ItemId,
                BrowseFlag: 'BrowseDirectChildren',
                Filter: '*',
                StartingIndex: 0,
                RequestedCount: 1000, 
                SortCriteria: ''
             });
          } catch { /* ignore */ }

          if (!result || !result.Result || !result.Result.includes('<item')) {
               const hashIndex = favorite.TrackUri.indexOf('#');
               if (hashIndex > -1) {
                   const realObjectId = favorite.TrackUri.substring(hashIndex + 1);
                   try {
                       result = await this.sonosDevice.ContentDirectoryService.Browse({
                          ObjectID: realObjectId,
                          BrowseFlag: 'BrowseDirectChildren',
                          Filter: '*',
                          StartingIndex: 0,
                          RequestedCount: 1000, 
                          SortCriteria: ''
                       });
                   } catch {
                       try {
                           const encodedId = encodeURIComponent(realObjectId).replace(/%2F/g, '/').replace(/%3A/g, ':');
                           result = await this.sonosDevice.ContentDirectoryService.Browse({
                              ObjectID: encodedId,
                              BrowseFlag: 'BrowseDirectChildren',
                              Filter: '*',
                              StartingIndex: 0,
                              RequestedCount: 1000, 
                              SortCriteria: ''
                           });
                       } catch { /* ignore */ }
                   }
               }
          }

          if (!result || typeof result.Result !== 'string') {
              streamDeck.logger.warn(`${logPrefix} No XML result.`);
              return false;
          }

          interface TrackInfo {
              uri: string;
              title: string;
              protocolInfo: string;
              sortKey: string;
          }
          
          const items: TrackInfo[] = [];
          const itemRegex = /<item[\s\S]*?<\/item>/g;
          let itemMatch;
          
          while ((itemMatch = itemRegex.exec(result.Result)) !== null) {
              const itemXml = itemMatch[0];
              const resMatch = itemXml.match(/<res[^>]*>(.*?)<\/res>/);
              const titleMatch = itemXml.match(/<dc:title>(.*?)<\/dc:title>/);
              
              if (resMatch && resMatch[1]) {
                  const rawUriFromXml = resMatch[1];
                  
                  // Decode XML entities (e.g. &amp; → &). Do NOT percent-encode '#' — the URI must remain exactly as it was in the XML.
                  const cleanUri = this.decodeXmlEntities(rawUriFromXml);
                  
                  const title = titleMatch ? this.decodeXmlEntities(titleMatch[1]) : "Track";
                  
                  let protocolInfo = "x-file-cifs:*:audio/mpeg:*";
                  const resTagFull = itemXml.match(/<res([^>]*)>/);
                  if (resTagFull && resTagFull[1]) {
                      const protoMatch = resTagFull[1].match(/protocolInfo="([^"]*)"/);
                      if (protoMatch && protoMatch[1]) {
                          protocolInfo = protoMatch[1];
                      }
                  }

                  // Filter M3U
                  if (cleanUri.toLowerCase().endsWith('.m3u') || cleanUri.toLowerCase().endsWith('.m3u8')) {
                      continue;
                  }
                  
                  if (!itemXml.includes('object.container')) {
                      items.push({ 
                          uri: cleanUri, 
                          title: title,
                          protocolInfo: protocolInfo,
                          sortKey: cleanUri 
                      });
                  }
              }
          }

          if (items.length === 0) {
              streamDeck.logger.warn(`${logPrefix} No tracks found.`);
              return false;
          }

          items.sort((a, b) => a.sortKey.localeCompare(b.sortKey, undefined, { numeric: true, sensitivity: 'base' }));

          streamDeck.logger.info(`${logPrefix} Found ${items.length} sorted tracks. Enqueuing...`);

          await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

          let count = 0;
          for (const item of items) {
              const metadata = this.generateMetadata(
                  item.title, 
                  item.uri, 
                  'object.item.audioItem.musicTrack', 
                  item.protocolInfo
              );

              if (count === 0) {
                  streamDeck.logger.debug(`${logPrefix} First Track URI: ${item.uri}`);
              }

              await this.sonosDevice.AVTransportService.AddURIToQueue({
                  InstanceID: 0,
                  EnqueuedURI: item.uri, 
                  EnqueuedURIMetaData: metadata,
                  DesiredFirstTrackNumberEnqueued: 0,
                  EnqueueAsNext: false
              });
              count++;
          }

          await this.sonosDevice.SwitchToQueue();
          await this.sonosDevice.Play();
          return true;

      } catch (e) {
          streamDeck.logger.error(`${logPrefix} Error processing folder: ${e}`);
          return false;
      }
  }

  // --- Main Logic: Play Favorite ---

  /**
   * Like playFavorite, but fades the current playback out first — across the WHOLE group: every
   * member of this device's current group ramps down in parallel. Once the new favorite has been
   * started, each member is set straight back to ITS OWN pre-fade volume (no fade-in — a ramp-up
   * mostly played out inaudibly during radio stream buffering anyway; per-member volumes are
   * deliberately individual on Sonos, e.g. a line-out zone running much louder than the rest).
   * Falls back to a plain playFavorite when nothing is audibly playing (paused, or every member
   * at volume 0).
   */
  async playFavoriteWithFade(favorite: any, fadeOutMs: number): Promise<void> {
    const generation = ++this.fadeGeneration;
    const cancelled = () => this.fadeGeneration !== generation;

    let isPlaying = false;
    try {
      isPlaying = (await this.getTransportState()) === 'PLAYING';
    } catch { /* device didn't answer — treat as not playing and switch without fade */ }

    const members = (fadeOutMs > 0 && isPlaying) ? await this.collectFadeMembers() : [];
    const audible = members.filter((m) => m.preVolume > 0);

    if (fadeOutMs <= 0 || !isPlaying || audible.length === 0) {
      await this.playFavorite(favorite);
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
      if (cancelled()) return; // a newer favorite press took over mid-fade
      await this.playFavorite(favorite);
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
      const managed = sonosManager.Devices.find((d) => d.Host === this.deviceIp);
      const myCoordinatorHost = managed?.Coordinator?.Host ?? managed?.Host ?? this.deviceIp;
      hosts = sonosManager.Devices
        .filter((d) => (d.Coordinator?.Host ?? d.Host) === myCoordinatorHost)
        .map((d) => d.Host);
      if (!hosts.includes(this.deviceIp)) hosts.push(this.deviceIp);
    } catch {
      hosts = [this.deviceIp]; // discovery not ready — fade at least this device
    }

    const members: Array<{ host: string; preVolume: number; liveVolume: number; setVolume: (v: number) => Promise<void>; notifyFading: (fading: boolean, durationMs: number) => void }> = [];
    await Promise.all(hosts.map(async (host) => {
      const controller = host === this.deviceIp ? this : sonosDeviceManager.peekController(host);
      if (controller) {
        members.push({
          host,
          preVolume: this.preFadeVolumes.get(host) ?? controller.currentVolume,
          liveVolume: controller.currentVolume,
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
              SET_VOLUME_TIMEOUT_MS,
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

  // Sets this device's volume AND keeps currentVolume + volume callbacks in sync, exactly like a
  // device event would. Silently poking currentVolume instead made the event/poll dedup treat the
  // device's own echo of every fade step as "no change", so watching Volume dials froze mid-fade
  // and stayed stale afterwards (hardware-observed: the pie chart simply stopped updating). The
  // later echo events dedup away correctly because currentVolume already matches.
  private async applyFadeVolume(volume: number): Promise<void> {
    await this.setVolume(volume);
    if (volume !== this.currentVolume) {
      this.currentVolume = volume;
      this.volumeInfoCallbacks.forEach((cb) => cb({ volume, mute: this.currentMute }));
    }
  }

  private async ramp(setVolume: (v: number) => Promise<void>, from: number, to: number, durationMs: number, isCancelled: () => boolean): Promise<void> {
    for (const step of computeFadeSteps(from, to, durationMs)) {
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      if (isCancelled()) return;
      await setVolume(step.volume);
    }
  }

  async playFavorite(favorite: any): Promise<void> {
    const logPrefix = `[PlayFavorite] [${favorite.Title}]`;
    streamDeck.logger.info(`${logPrefix} START.`);
    
    try {
        // --- 1. SPOTIFY PLAYLIST ---
        if (favorite.TrackUri.includes('spotify:playlist:')) {
            streamDeck.logger.info(`${logPrefix} Spotify Playlist. Using MetadataHelper.`);
            const match = favorite.TrackUri.match(/spotify:playlist:([a-zA-Z0-9]+)/);
            if (match && match[1]) {
                const cleanUri = `spotify:playlist:${match[1]}`;
                const guessedData = MetaDataHelper.GuessMetaDataAndTrackUri(cleanUri);
                
                if (guessedData && guessedData.metadata && guessedData.trackUri) {
                    await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });
                    await this.sonosDevice.AVTransportService.AddURIToQueue({
                        InstanceID: 0,
                        EnqueuedURI: guessedData.trackUri,
                        EnqueuedURIMetaData: guessedData.metadata,
                        DesiredFirstTrackNumberEnqueued: 0,
                        EnqueueAsNext: false
                    });
                    await this.sonosDevice.SwitchToQueue();
                    await this.sonosDevice.Play();
                    streamDeck.logger.info(`${logPrefix} SUCCESS (Spotify).`);
                    return;
                }
            }
        }

        // --- 2. MUSIC LIBRARY / NAS FOLDER ---
        if (favorite.TrackUri.startsWith('x-rincon-playlist') || favorite.TrackUri.startsWith('x-file-cifs')) {
            streamDeck.logger.info(`${logPrefix} Music Library/Folder detected. Trying custom expansion.`);
            
            const success = await this.handleLocalFolder(favorite);
            
            if (success) {
                streamDeck.logger.info(`${logPrefix} SUCCESS (Music Library Custom).`);
                return;
            }

            // FALLBACK
            streamDeck.logger.warn(`${logPrefix} Custom expansion failed. Fallback to native Container Queueing.`);
            await this.sonosDevice.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 });

            let containerId = favorite.ItemId;
            const hashIndex = favorite.TrackUri.indexOf('#');
            if (hashIndex > -1) {
                containerId = favorite.TrackUri.substring(hashIndex + 1);
            }

            const metadata =
                '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
                `<item id="${containerId}" parentID="${favorite.ParentId}" restricted="true">` +
                `<dc:title>${this.encodeXml(favorite.Title)}</dc:title>` +
                `<upnp:class>object.container.playlistContainer</upnp:class>` + 
                `<res protocolInfo="${favorite.ProtocolInfo}">${this.encodeXml(favorite.TrackUri)}</res>` +
                `</item></DIDL-Lite>`;

            await this.sonosDevice.AVTransportService.AddURIToQueue({
                InstanceID: 0,
                EnqueuedURI: favorite.TrackUri,
                EnqueuedURIMetaData: metadata,
                DesiredFirstTrackNumberEnqueued: 0,
                EnqueueAsNext: false
            });

            await this.sonosDevice.SwitchToQueue();
            await this.sonosDevice.Play();
            streamDeck.logger.info(`${logPrefix} SUCCESS (Music Library Fallback).`);
            return;
        }

        // --- 3. RADIO / DIRECT URI ---
        // Use the r:resMD field from the raw Browse response as CurrentURIMetaData.
        // r:resMD is pre-HTML-encoded DIDL-Lite with the correct id, upnp:class, and cdudn.
        // Passing it as a string bypasses TrackToMetaData, which corrupts UpnpClass when the
        // SDK parses two <upnp:class> elements and concatenates them (causing UPnP 402).
        const resMd = sonosFavoritesCache.getResMd(favorite.TrackUri);
        streamDeck.logger.info(`${logPrefix} Standard/Radio detected. URI="${favorite.TrackUri}"`);

        await this.sonosDevice.AVTransportService.SetAVTransportURI({
            InstanceID: 0,
            CurrentURI: favorite.TrackUri,
            CurrentURIMetaData: resMd ?? { ...favorite },
        });

        await this.sonosDevice.Play();
        streamDeck.logger.info(`${logPrefix} SUCCESS (Radio).`);

    } catch (error: any) {
        streamDeck.logger.error(`${logPrefix} ERROR: ${error}`);
        throw error;
    }
  }


  async getCurrentTrackCover(): Promise<string | undefined> {
      const positionInfo = await this.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
      const trackMetadata = positionInfo.TrackMetaData;

      streamDeck.logger.debug(`[getCurrentTrackCover] TrackURI="${positionInfo.TrackURI}", metadataType=${typeof trackMetadata}`);

      // Queue playback: metadata is parsed and contains AlbumArtUri.
      if (typeof trackMetadata !== 'string' && trackMetadata.AlbumArtUri) {
          return await loadImageFromUri(trackMetadata.AlbumArtUri, this.transportDevice);
      }

      // Some radio stations (confirmed on hardware: WDR2 via TuneIn) report no AlbumArtUri and a
      // useless URL-derived Title in GetPositionInfo, while GetMediaInfo's CurrentURIMetaData has
      // the real station logo (an absolute external URL, e.g. https://.../logo.jpg) and name —
      // this is what surfaces the cover in other Sonos clients (e.g. Home Assistant) even when our
      // own GetPositionInfo-based path finds nothing.
      try {
          const mediaInfo = await this.transportDevice.AVTransportService.GetMediaInfo({ InstanceID: 0 });
          const mediaMeta = mediaInfo.CurrentURIMetaData;
          if (typeof mediaMeta !== 'string' && mediaMeta.AlbumArtUri) {
              const artUrl = SonosDeviceController.upsizeSonosImageProxyUrl(mediaMeta.AlbumArtUri);
              const cover = await loadImageFromUri(artUrl, this.transportDevice);
              if (cover) return cover;
          }
      } catch { /* fall through to the /getaa guess below */ }

      // Radio / streaming: derive the art from the stream URI via the Sonos /getaa endpoint.
      // This works regardless of whether TrackMetaData is a plain string (some radio) or a
      // parsed object without AlbumArtUri (other radio). The URI stays stable during news
      // segments, so the station logo keeps showing.
      if (positionInfo.TrackURI) {
          const artUri = `/getaa?s=1&u=${encodeURIComponent(positionInfo.TrackURI)}`;
          streamDeck.logger.debug(`[getCurrentTrackCover] Trying radio art: ${artUri.substring(0, 80)}`);
          const cover = await loadImageFromUri(artUri, this.transportDevice);
          if (cover) return cover;
      }

      // Buffered cover — set during UPnP track events; news events preserve the previous cover.
      if (this.currentTrack?.albumArtDataUri) return this.currentTrack.albumArtDataUri;

      // Final fallback: last cover that was ever successfully loaded for this device.
      return this.lastKnownCover;
  }
  async getCurrentTrack(): Promise<Track | undefined> {
    const positionInfo = await this.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
    const trackMetadata = positionInfo.TrackMetaData;
    let track: Track | undefined = typeof trackMetadata !== 'string' ? trackMetadata : undefined;

    // Some radio stations report a URL-derived junk Title (and/or no AlbumArtUri) in
    // GetPositionInfo — GetMediaInfo's CurrentURIMetaData has the real station name/logo instead
    // (confirmed on hardware: WDR2 via TuneIn gave Title "stream.mp3?aggregator=..." here, but
    // "WDR 2 Rhein und Ruhr" via GetMediaInfo). Only overlay the fields that are actually missing/
    // bad — don't clobber good metadata queue playback already has.
    if (!track || SonosDeviceController.looksLikeRawStreamFilename(track.Title) || !track.AlbumArtUri) {
        try {
            const mediaInfo = await this.transportDevice.AVTransportService.GetMediaInfo({ InstanceID: 0 });
            const mediaMeta = mediaInfo.CurrentURIMetaData;
            if (typeof mediaMeta !== 'string') {
                const needsTitle = !track?.Title || SonosDeviceController.looksLikeRawStreamFilename(track.Title);
                track = {
                    ...(track ?? {} as Track),
                    Title: needsTitle && mediaMeta.Title ? mediaMeta.Title : track?.Title,
                    AlbumArtUri: track?.AlbumArtUri || (mediaMeta.AlbumArtUri ? SonosDeviceController.upsizeSonosImageProxyUrl(mediaMeta.AlbumArtUri) : undefined),
                } as Track;
            }
        } catch { /* keep whatever GetPositionInfo already gave us */ }
    }
    return track;
  }
  
  async getZoneAttributes(debug?: boolean): Promise<GetZoneAttributesResponse> {
    const zoneAttributes = await this.sonosDevice.DevicePropertiesService.GetZoneAttributes();
    if (debug) streamDeck.logger.debug(zoneAttributes);
    return zoneAttributes;
  }
  async getZoneGroupState(debug?: boolean): Promise<SonosZoneGroupStates> {
    const zoneGroupState = await this.sonosDevice.GetZoneGroupState();
    if (debug) streamDeck.logger.debug(zoneGroupState);
    return zoneGroupState as SonosZoneGroupStates;
  }
  async getFavorites(debug?: boolean): Promise<any> {
    const favorites = this.sonosDevice.GetFavoriteRadioStations();
    if (debug) streamDeck.logger.debug(favorites);
    return favorites;
  }

  // Queue lives on the group coordinator, same as every other AVTransport call — use
  // transportDevice, not sonosDevice, so this also works for grouped members.
  async getQueue(): Promise<Track[]> {
    const resp = await this.transportDevice.GetQueue();
    return normalizeBrowseResult(resp);
  }

  // 0-based current position within the queue, or -1 if not applicable (e.g. radio, no track).
  async getCurrentQueuePosition(): Promise<number> {
    const positionInfo = await this.transportDevice.AVTransportService.GetPositionInfo({ InstanceID: 0 });
    const track = positionInfo.Track;
    return typeof track === 'number' && track > 0 ? track - 1 : -1;
  }
}
