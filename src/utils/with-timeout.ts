// An unreachable device's request can otherwise hang for the OS-level TCP connect timeout
// (20-30s+ on Windows) before rejecting — long enough to freeze a shared send-throttle or a
// polling loop waiting on it (see SonosDeviceController.setVolume's use of this, which fixed a
// real 30s GroupVolumeDial freeze from one unreachable stereo-pair speaker). Races the given
// promise against a short timeout so callers get a bounded, predictable failure instead.
//
// The "losing" promise (if it's the real call, not the timeout) is still internally subscribed-to
// by Promise.race itself, so its eventual real settlement — even after we've already timed out and
// moved on — never surfaces as an unhandled rejection.
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        )),
    ]);
}
