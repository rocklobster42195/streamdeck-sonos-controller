// The keys' title animation (band fades in, title scrolls and fades, band fades out, pause) with the
// kit's TitleFader as the state machine — this file keeps what the keys draw around it: the cover
// (with its own crossfade), the battery badge and the progress bar, at 72 px.
import { measureArialWidth, TitleFader, type TitleFaderConfig } from '@rocklobster42195/streamdeck-kit';
import { renderProgressBar } from './icons';

export interface AnimationOptions {
    text: string;
    backgroundImage?: string;
    fontSize?: number;
    fontColor?: string;
    /** Pixels per tick. */
    speed?: number;
    /** Ticks a short title stands still, and the pause between loops. */
    pauseDuration?: number;
    /** Tick interval (ms). */
    interval?: number;
    // Pre-rendered SVG fragment (e.g. from utils/icons.ts renderBatteryBadge) composited on top,
    // independent of text/backgroundImage changes — see setBatteryBadge().
    batteryBadge?: string;
    // 0-1 playback progress to draw the bar for, or undefined when the current source has no
    // known duration (radio) — renderProgressBar skips drawing entirely in that case.
    progress?: number;
    progressColor?: string;
}

/** The kit's Sonos preset is for 144 px keys; these are the original 72 px values. */
const MEASURE_SCALE = 1.055;
const TEXT_Y = 60;

interface AnimationState {
    action: any;
    options: AnimationOptions;
    fader: TitleFader;
    intervalId?: NodeJS.Timeout;
    isFading: boolean;
    oldBackgroundImage?: string;
    fadeOpacity: number;
}

function faderConfig(o: AnimationOptions): TitleFaderConfig {
    return {
        size: 72,
        startX: 18,
        endX: 72,
        speed: o.speed || 1.1,
        pauseTicks: o.pauseDuration || 40,
        measureScale: MEASURE_SCALE,
        fontSize: o.fontSize || 13,
        y: TEXT_Y,
        boxMax: 0.3,
        boxStep: 0.05,
        textStep: 0.1,
        // The original 72 px band: from 2 px above the cap height, 8 px taller than the font
        bandTop: 2,
        bandExtra: 8,
    };
}

export class TitleAnimator {
    private animationStates: Map<string, AnimationState> = new Map();

    /** Width of a bold title as the animation measures it (Arial Bold, scaled like the fader). */
    public async measure(text: string, fontSize: number): Promise<number> {
        return measureArialWidth(text, fontSize, true) * MEASURE_SCALE;
    }

    public isRunning(context: string): boolean {
        return this.animationStates.has(context);
    }

    // Temporary diagnostic (2026-07-18) — see debugCallbackCounts on SonosDeviceController.
    public get activeCount(): number {
        return this.animationStates.size;
    }

    // Updates the battery badge independently of text/backgroundImage — does not reset scroll
    // phase. Picked up on the next tick of the already-running render interval.
    public setBatteryBadge(context: string, badge: string): void {
        const state = this.animationStates.get(context);
        if (state) state.options.batteryBadge = badge;
    }

    // Updates the progress bar independently of everything else — same rationale as
    // setBatteryBadge. The caller (play-pause-key.ts) owns its own ~1s timer.
    public setProgress(context: string, progress: number | undefined, color?: string): void {
        const state = this.animationStates.get(context);
        if (!state) return;
        state.options.progress = progress;
        if (color !== undefined) state.options.progressColor = color;
    }

    public async update(context: string, newOptions: { text: string; backgroundImage?: string }): Promise<void> {
        const state = this.animationStates.get(context);
        if (!state) return;

        if (newOptions.backgroundImage !== state.options.backgroundImage) {
            state.isFading = true;
            state.fadeOpacity = 0;
            state.oldBackgroundImage = state.options.backgroundImage;
            state.options.backgroundImage = newOptions.backgroundImage;
        }
        state.options.text = newOptions.text;
        state.fader.setText(newOptions.text);
    }

    public async start(action: any, options: AnimationOptions): Promise<void> {
        const context = action.id;
        this.stop(context);

        const state: AnimationState = {
            action,
            options,
            fader: new TitleFader(options.text || '', faderConfig(options)),
            isFading: false,
            fadeOpacity: 0,
        };

        state.intervalId = setInterval(async () => {
            if (state.isFading) {
                state.fadeOpacity += 0.1;
                if (state.fadeOpacity >= 1) {
                    state.fadeOpacity = 1;
                    state.isFading = false;
                    state.oldBackgroundImage = undefined;
                }
            }
            state.fader.step();
            await state.action.setImage(this.renderSvg(state));
        }, options.interval || 50);

        this.animationStates.set(context, state);
    }

    public stop(contextOrAction: string | any): void {
        const context = typeof contextOrAction === 'string' ? contextOrAction : contextOrAction.id;
        const state = this.animationStates.get(context);
        if (state) {
            clearInterval(state.intervalId);
            this.animationStates.delete(context);
        }
    }

    private renderSvg(state: AnimationState): string {
        const { options, isFading, oldBackgroundImage, fadeOpacity } = state;

        let bgHtml = '';
        if (isFading && oldBackgroundImage && options.backgroundImage) {
            bgHtml = `
                <image href="${oldBackgroundImage}" width="72" height="72" preserveAspectRatio="xMidYMid slice" opacity="${1 - fadeOpacity}" />
                <image href="${options.backgroundImage}" width="72" height="72" preserveAspectRatio="xMidYMid slice" opacity="${fadeOpacity}" />
            `;
        } else if (options.backgroundImage) {
            bgHtml = `<image href="${options.backgroundImage}" width="72" height="72" preserveAspectRatio="xMidYMid slice" />`;
        } else {
            bgHtml = `<rect width="72" height="72" fill="black" />`;
        }

        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
                ${bgHtml}
                ${state.fader.svg(options.fontColor || '#ffffff')}
                ${options.batteryBadge || ''}
                ${renderProgressBar(options.progress, options.progressColor || '#CCCCCC')}
            </svg>
        `;
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }
}

export const titleAnimator = new TitleAnimator();
