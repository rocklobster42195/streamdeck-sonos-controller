// Shared contract for Panorama Effects. See CONTRIBUTING_EFFECTS.md for the full guide.
//
// `id`, `displayName`, `defaultSettings`, and `settingsSchema` on EffectDefinition MUST be
// plain object/array/string/number/boolean literals — the codegen script
// (tools/generate-effects-registry.mjs) reads them straight off the source AST, without
// executing the module, to build the Property Inspector's manifest. Only `createInstance`
// may contain arbitrary logic/imports.

export type EffectField =
    | { key: string; type: 'range'; label: string; min: number; max: number; step?: number; default: number }
    | { key: string; type: 'color'; label: string; default: string }
    | { key: string; type: 'checkbox'; label: string; default: boolean }
    | { key: string; type: 'select'; label: string; options: { label: string; value: string }[]; default: string };

export interface PanoramaInitContext<S> {
    /** Total panorama width in px = number of displays currently in the group x 200. */
    width: number;
    /** Always 100. */
    height: number;
    settings: S;
}

export interface EffectInstance<S = Record<string, unknown>> {
    /** Called on group formation AND every time group membership changes (a display joins or
     *  leaves). `width` reflects the CURRENT panorama size — never cache it beyond one call. */
    initPanorama(ctx: PanoramaInitContext<S>): void;
    /** Called once per tick PER GROUP (not per display). Do all physics/state advancement here —
     *  never in renderSlice, see CONTRIBUTING_EFFECTS.md's Dos and Don'ts. */
    tickPanorama(dtMs: number): void;
    /** Called once per tick PER DISPLAY. Must only project/draw the state tickPanorama already
     *  computed. Returns an SVG fragment (no outer <svg> tag). */
    renderSlice(offsetX: number, width: number, height: number): string;

    /** Called when the host's PI-managed settings change (e.g. a device's dominant color). */
    onSettingsChange?(settings: S): void;
    destroy?(): void;

    /** Optional interaction hooks. Only ever invoked when this effect runs on the Panorama
     *  Effects action itself — Track/Volume/Group Volume dials keep rotate/press/touch bound to
     *  their own primary function and never forward them to the effect. */
    onRotate?(ticks: number): void;
    onPress?(): void;
    onTouch?(x: number, y: number): void;

    /** Optional 0-100 value shown on the dial's ring indicator. */
    getIndicatorValue?(): number;
    /** Optional: return the subset of settings this effect wants persisted after onRotate/onPress
     *  changed its internal state (e.g. a live-tunable density/speed). Read before saving. */
    getRuntimeSettings?(): Partial<S>;
}

export interface EffectDefinition<S = Record<string, unknown>> {
    /** Stable id, stored in user settings. Never change this once released — renaming it resets
     *  every user's saved settings for this effect. */
    id: string;
    /** Shown in the effect picker dropdown in the Property Inspector. */
    displayName: string;
    defaultSettings: S;
    /** Drives auto-generated PI controls. Field labels/keys are entirely up to you. */
    settingsSchema: EffectField[];
    createInstance(): EffectInstance<S>;
}
