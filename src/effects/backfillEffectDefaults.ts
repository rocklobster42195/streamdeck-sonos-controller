import { effectRegistry } from "./registry.generated";

// Fills in any of `effectId`'s settingsSchema fields that are missing from `settings` with their
// schema default, and persists the result via setSettings if anything changed. This runs on the
// backend (not the PI) deliberately — see ui/effect-fields.js's comment on why a PI-side
// getSettings()/setSettings() round trip for this turned out to corrupt settings instead. Missing
// fields happen naturally: a brand new effect field nobody has touched yet (e.g. right after this
// field was added to an effect's schema) has no value in already-saved settings at all, and
// without backfilling it, a color field's control would surface a blank/invalid value until the
// user happens to touch it themselves.
export function backfillEffectDefaults(settings: Record<string, unknown>, effectId: string | undefined): { settings: Record<string, unknown>; changed: boolean } {
    if (!effectId) return { settings, changed: false };
    const def = effectRegistry.get(effectId);
    if (!def) return { settings, changed: false };
    let changed = false;
    const result: Record<string, unknown> = { ...settings };
    for (const field of def.settingsSchema) {
        if (result[field.key] === undefined) {
            result[field.key] = field.default;
            changed = true;
        }
    }
    return { settings: result, changed };
}
