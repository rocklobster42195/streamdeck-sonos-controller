// Recovery loop for the "configured but unreachable" state: an action whose initial setup
// failed (speaker powered off, e.g. a battery Roam) shows the speaker-off placeholder — but
// nothing would ever retry, so the tile stayed dead even after the speaker came back and music
// was already playing. Each action schedules a retry of its own setup here from its catch path;
// the retry is cancelled whenever a newer setup runs (fresh settings/appearance) or the instance
// disappears, so at most one pending retry exists per context and a successful setup ends the
// loop naturally (success paths never schedule).
//
// 30s interval: a failed attempt against a dead IP can itself take many seconds of TCP timeout,
// so retrying much faster just stacks connection attempts without making recovery snappier.
const DEFAULT_RETRY_MS = 30_000;

export class SetupRetryScheduler {
    private timers: Map<string, NodeJS.Timeout> = new Map();

    constructor(private readonly delayMs: number = DEFAULT_RETRY_MS) {}

    schedule(context: string, retry: () => void): void {
        this.cancel(context);
        this.timers.set(context, setTimeout(() => {
            this.timers.delete(context);
            retry();
        }, this.delayMs));
    }

    cancel(context: string): void {
        const timer = this.timers.get(context);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(context);
        }
    }
}
