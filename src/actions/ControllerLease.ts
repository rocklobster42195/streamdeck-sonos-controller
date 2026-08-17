// Pairs acquiring a pooled controller with registering callbacks on it, so release always
// unregisters everything a matching acquire registered — the leak class REFACTORING.md §1 fixed
// twice by hand (a settings-cleared early return skipping release; an unregister list falling out
// of sync with the register list) becomes structurally hard to reproduce. Composable (not a base
// class) so it works for actions extending SingletonAction directly and ones already extending
// PanoramaCapableDialAction. Mirrors what VolumePieDialAction.ts already does successfully for
// Volume/Group Volume Dial, generalized for actions that don't share that base class.
export class ControllerLease<TController> {
    private entries: Map<string, { controller: TController; unregister: () => void }> = new Map();

    constructor(
        private readonly acquireFn: (id: string) => Promise<TController>,
        private readonly releaseFn: (controller: TController) => void,
    ) {}

    has(context: string): boolean {
        return this.entries.has(context);
    }

    get(context: string): TController | undefined {
        return this.entries.get(context)?.controller;
    }

    /**
     * Acquires a fresh controller for `id` and runs `register`, which must return the unregister
     * thunks matching whatever it registered. Does NOT release any existing lease for `context`
     * first — callers call `release(context)` unconditionally before this, same as the acquire-time
     * guard every action already had, so a config-cleared early return still releases correctly.
     */
    async acquire(context: string, id: string, register: (controller: TController) => (() => void)[]): Promise<TController> {
        const controller = await this.acquireFn(id);
        const unregisterFns = register(controller);
        this.entries.set(context, { controller, unregister: () => unregisterFns.forEach((fn) => fn()) });
        return controller;
    }

    /** Idempotent — safe to call even when nothing is currently leased for `context`. */
    release(context: string): void {
        const entry = this.entries.get(context);
        if (!entry) return;
        entry.unregister();
        this.releaseFn(entry.controller);
        this.entries.delete(context);
    }
}
