import { describe, expect, it } from 'vitest';
import fixtures from '../test-fixtures/profile-settings.json';
import { socRowState } from './panorama';

// Old per-dial choices from the user's real profiles (anonymised) → the kit's row state.
const NON_EFFECT = new Set(['none', 'eq', 'mosaic']);
type Fixture = { action: string; settings: Record<string, unknown> };
const dials = (fixtures as Fixture[]).filter((f) => f.action.endsWith('-dial') && f.action !== 'diagnostics-dial');

describe('socRowState (migration of the old per-dial effect)', () => {
    for (const f of dials) {
        const effectsDial = f.action === 'panorama-effects-dial';
        const old = (effectsDial ? f.settings.effectId : f.settings.visualizerMode) as string | undefined;
        const isEffect = !!old && !NON_EFFECT.has(old);
        it(`${f.action} with ${old ?? 'nothing'}`, () => {
            const state = socRowState(f.settings, isEffect || effectsDial ? old ?? 'particles' : undefined, effectsDial);
            if (isEffect || effectsDial) {
                expect(state.member).toBe(true);
                expect(state.row?.effect).toBe(old ?? 'particles');
                expect(state.row?.stamp).toBe(effectsDial ? 2 : 1);
            } else {
                expect(state.member).toBe(false);
                expect(state.row).toBeUndefined();
            }
        });
    }

    it('keeps the old tuning fields as the row settings', () => {
        const s = socRowState({ visualizerMode: 'particles', savedDensity: 28, savedSpeed: 0.95, showText: true }, 'particles');
        expect(s.row?.settings).toEqual({ savedDensity: 28, savedSpeed: 0.95 });
    });

    it('lets a freshly placed dial take part', () => {
        expect(socRowState({}, undefined)).toEqual({ member: true });
    });

    it('uses the kit state once a row was stored', () => {
        const s = socRowState({ visualizerMode: 'particles', panorama: { effect: 'matrix-rain', settings: {}, stamp: 5 }, panoramaMember: false }, 'particles');
        expect(s).toEqual({ row: { effect: 'matrix-rain', settings: {}, stamp: 5 }, member: false });
    });
});
