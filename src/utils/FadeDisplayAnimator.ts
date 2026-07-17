// Per-context display-value animation for anything that visualizes a Sonos volume: eases the
// shown value toward the real one on echoes/fast spins, and — during a group fade-out (see
// SonosDeviceController.fadeGroupThenRun) — fakes a smooth, continuous descent to 0 over the
// fade's known duration instead of showing the real, coarsely-stepped SetVolume echoes
// (~150ms+ apart, see volume-fade.ts), then glides back up to the restored volume.
//
// This logic existed three times (Volume Dial, Group Volume Dial, Volume Control Key), each
// copy carrying the same hardware-debugged pitfalls in comments. The two non-obvious ones,
// preserved here:
//
// (1) The fade's start value must be read from the CACHED display value BEFORE flipping
//     `fading` — computing it via current() after flipping would see fading=true plus stale
//     fadeStartTime/fadeDurationMs left over from a PREVIOUS fade and start every fade after
//     the first one from 0 instead of the real current volume (hit on hardware).
//
// (2) current() computes the mid-fade value on demand from elapsed real time rather than a
//     timer-written field — a dial with an active Panorama effect background has its OWN ~50ms
//     render tick independent of the fade timer, and two independently-paced timers each
//     rendering a value the OTHER last wrote made the pie visibly stutter (hit on hardware).
//     The internal timers below are only redraw pulses for contexts with no other render loop.

const TICK_MS = 25;
// Ease factor per tick toward the target; snaps once within this epsilon.
const EASE_FACTOR = 0.4;
const SNAP_EPSILON = 0.3;

export class FadeDisplayAnimator {
    private target?: number;
    private display?: number;

    private fading = false;
    private fadeStartVolume = 0;
    private fadeStartTime = 0;
    private fadeDurationMs = 1;

    private volumeTimer?: NodeJS.Timeout;
    private fadeTimer?: NodeJS.Timeout;

    constructor(private readonly render: () => void) {}

    /** The real (target) volume, or undefined before the first initialize/echo. */
    get targetVolume(): number | undefined { return this.target; }

    get isFading(): boolean { return this.fading; }

    /** Snap target and display to `volume` with no animation — initial state after setup. */
    initialize(volume: number): void {
        this.stopVolumeAnim();
        this.target = volume;
        this.display = volume;
    }

    /** The value to draw right now (mid-fade values computed on demand — see header). */
    current(): number {
        if (this.fading) {
            const progress = Math.min(1, (Date.now() - this.fadeStartTime) / this.fadeDurationMs);
            return this.fadeStartVolume * (1 - progress);
        }
        return this.display ?? this.target ?? 0;
    }

    /**
     * User rotation: `ease` for a fast spin (Stream Deck coalesced several detents into one
     * event — glide toward it), snap for a normal single-detent turn (no catch-up lag).
     */
    setTarget(volume: number, ease: boolean): void {
        this.target = volume;
        if (ease) {
            this.startVolumeAnim();
        } else {
            this.stopVolumeAnim();
            this.display = volume;
        }
    }

    /**
     * Device-echoed volume (UPnP event/poll). While a fade is running the echoes are exactly
     * the coarse steps this class exists to hide — the target still tracks reality, but no
     * animation/render is triggered until the fade ends.
     */
    onEcho(volume: number): void {
        this.target = volume;
        if (!this.fading) this.startVolumeAnim();
    }

    /** Relay of SonosDeviceController.registerFadeStateCallback (directly or via group relay). */
    onFadeState(fading: boolean, durationMs: number): void {
        if (fading) {
            this.stopVolumeAnim();
            // Cached value BEFORE flipping this.fading — see pitfall (1) in the header.
            this.fadeStartVolume = this.display ?? this.target ?? 0;
            this.fading = true;
            this.fadeStartTime = Date.now();
            this.fadeDurationMs = Math.max(1, durationMs);
            this.startFadeAnim();
        } else {
            // Freeze wherever the live-computed descent currently is — this.fading flips false
            // right after, so current()'s fade branch won't be consulted again, and the glide
            // back up needs a definite starting point.
            this.display = this.current();
            this.fading = false;
            this.stopFadeAnim();
            // Ease from the fade's end value back up to the real (already-restored) volume —
            // reads as one continuous motion rather than a hard cut.
            this.startVolumeAnim();
        }
    }

    /** Clears both timers — call from the owner's cleanup path. */
    stop(): void {
        this.stopVolumeAnim();
        this.stopFadeAnim();
    }

    // Redraw pulse while easing toward the target — self-stops once it lands.
    private startVolumeAnim(): void {
        if (this.volumeTimer) return;
        this.volumeTimer = setInterval(() => {
            if (this.target === undefined) { this.stopVolumeAnim(); return; }
            const current = this.display ?? this.target;
            const diff = this.target - current;
            if (Math.abs(diff) < SNAP_EPSILON) {
                this.display = this.target;
                this.stopVolumeAnim();
            } else {
                this.display = current + diff * EASE_FACTOR;
            }
            this.render();
        }, TICK_MS);
    }

    private stopVolumeAnim(): void {
        if (this.volumeTimer) { clearInterval(this.volumeTimer); this.volumeTimer = undefined; }
    }

    // Redraw pulse while fading — current() computes the actual value; this only exists so a
    // context with NO other render loop still animates smoothly. Self-stops once fully faded
    // rather than ticking forever waiting for the fade-end signal, which can lag slightly.
    private startFadeAnim(): void {
        if (this.fadeTimer) return;
        this.fadeTimer = setInterval(() => {
            if (!this.fading) { this.stopFadeAnim(); return; }
            this.render();
            const progress = (Date.now() - this.fadeStartTime) / this.fadeDurationMs;
            if (progress >= 1) this.stopFadeAnim();
        }, TICK_MS);
    }

    private stopFadeAnim(): void {
        if (this.fadeTimer) { clearInterval(this.fadeTimer); this.fadeTimer = undefined; }
    }
}
