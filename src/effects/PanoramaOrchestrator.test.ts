import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    panoramaOrchestrator,
    safeEffectCall,
    registerInPanorama,
    unregisterFromPanorama,
    setContextEffectId,
    setContextEffectSettings,
    setSettingsChangeHandler,
    registerPanoramaRenderCallback,
    getPanoramaSliceOffset,
} from './PanoramaOrchestrator';
import streamDeck from '@elgato/streamdeck';

// panoramaOrchestrator is a module-level singleton — every test starts from a clean slate so
// state from one test can't leak into the next (see PanoramaOrchestrator.ts's own maps).
function resetOrchestrator(): void {
    panoramaOrchestrator.panoramaColumns.clear();
    panoramaOrchestrator.panoramaDeviceIds.clear();
    panoramaOrchestrator.panoramaContextGroupKey.clear();
    panoramaOrchestrator.contextEffectId.clear();
    panoramaOrchestrator.contextEffectSettings.clear();
    panoramaOrchestrator.groupEffects.clear();
    panoramaOrchestrator.renderCallbacks.clear();
}

describe('PanoramaOrchestrator', () => {
    beforeEach(() => {
        resetOrchestrator();
        setSettingsChangeHandler(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('computeAllGroups', () => {
        it('keeps adjacent columns split when they want different effects', () => {
            registerInPanorama('a', 0, 'device-1');
            registerInPanorama('b', 1, 'device-1');
            setContextEffectId('a', 'particles');
            setContextEffectId('b', 'boing-ball');

            const groups = panoramaOrchestrator.computeAllGroups();

            expect(groups.size).toBe(2);
            const memberSets = [...groups.values()];
            expect(memberSets).toContainEqual(['a']);
            expect(memberSets).toContainEqual(['b']);
        });

        it('keeps adjacent columns split when they are on different physical devices', () => {
            registerInPanorama('a', 0, 'device-1');
            registerInPanorama('b', 1, 'device-2');
            setContextEffectId('a', 'particles');
            setContextEffectId('b', 'particles');

            const groups = panoramaOrchestrator.computeAllGroups();

            expect(groups.size).toBe(2);
            const memberSets = [...groups.values()];
            expect(memberSets).toContainEqual(['a']);
            expect(memberSets).toContainEqual(['b']);
        });

        it('merges adjacent columns on the same device wanting the same effect', () => {
            registerInPanorama('a', 0, 'device-1');
            registerInPanorama('b', 1, 'device-1');
            setContextEffectId('a', 'particles');
            setContextEffectId('b', 'particles');

            const groups = panoramaOrchestrator.computeAllGroups();

            expect(groups.size).toBe(1);
            expect([...groups.values()][0].sort()).toEqual(['a', 'b']);
        });
    });

    describe('unregisterFromPanorama', () => {
        it('clears every per-context map and registry together', () => {
            registerInPanorama('a', 0, 'device-1');
            setContextEffectId('a', 'particles');
            setContextEffectSettings('a', { density: 5 });
            registerPanoramaRenderCallback('a', () => {});
            panoramaOrchestrator.panoramaContextGroupKey.set('a', 'panorama-device-1-cols-0');

            unregisterFromPanorama('a');

            expect(panoramaOrchestrator.panoramaColumns.has('a')).toBe(false);
            expect(panoramaOrchestrator.panoramaDeviceIds.has('a')).toBe(false);
            expect(panoramaOrchestrator.panoramaContextGroupKey.has('a')).toBe(false);
            expect(panoramaOrchestrator.contextEffectId.has('a')).toBe(false);
            expect(panoramaOrchestrator.contextEffectSettings.has('a')).toBe(false);
            expect(panoramaOrchestrator.renderCallbacks.has('a')).toBe(false);
        });
    });

    describe('requestSettingsPush debounce', () => {
        it('batches rapid setContextEffectSettings calls into one handler invocation with all contexts', () => {
            vi.useFakeTimers();
            const handler = vi.fn();
            setSettingsChangeHandler(handler);

            setContextEffectSettings('a', { density: 1 });
            setContextEffectSettings('b', { density: 2 });
            setContextEffectSettings('c', { density: 3 });

            expect(handler).not.toHaveBeenCalled();
            vi.advanceTimersByTime(60);

            expect(handler).toHaveBeenCalledTimes(1);
            const pushedContexts = [...handler.mock.calls[0][0] as Iterable<string>];
            expect(pushedContexts.sort()).toEqual(['a', 'b', 'c']);
        });
    });

    describe('getPanoramaSliceOffset', () => {
        it('returns 0 before any sync has assigned a group key', () => {
            registerInPanorama('a', 3, 'device-1');
            // Deliberately not calling computeAllGroups()/waiting for the debounce — the key is
            // not yet assigned for 'a'.
            expect(getPanoramaSliceOffset('a')).toBe(0);
        });
    });

    describe('safeEffectCall', () => {
        it('swallows a throwing effect call and returns the fallback, without breaking later calls', () => {
            const errorSpy = vi.spyOn(streamDeck.logger, 'error');

            const result = safeEffectCall(() => {
                throw new Error('boom');
            }, 'fallback-value', 'renderSlice');

            expect(result).toBe('fallback-value');
            expect(errorSpy).toHaveBeenCalled();

            const secondResult = safeEffectCall(() => 'ok', 'fallback-value', 'renderSlice');
            expect(secondResult).toBe('ok');
        });
    });
});
