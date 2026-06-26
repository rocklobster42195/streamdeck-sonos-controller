import streamDeck from '@elgato/streamdeck';
import * as opentype from 'opentype.js';
import * as path from 'path';
import * as fs from 'fs';

export interface AnimationOptions {
    text: string;
    backgroundImage?: string;
    fontSize?: number;
    fontColor?: string;
    speed?: number;
    pauseDuration?: number;
    interval?: number;
}

enum AnimPhase {
    BOX_IN,
    SCROLL_AND_FADE_IN,
    SCROLL_OPAQUE,
    SCROLL_AND_FADE_OUT,
    BOX_OUT,
    PAUSE_LOOP,
}

interface AnimationState {
    action: any;
    options: AnimationOptions;
    intervalId?: NodeJS.Timeout;
    offset: number;
    boxOpacity: number;
    textOpacity: number;
    phase: AnimPhase;
    pauseTicks: number;
    textWidth: number;
    shouldScroll: boolean;
    isFading: boolean;
    oldBackgroundImage?: string;
    fadeOpacity: number;
}

export class TitleAnimator {
    private animationStates: Map<string, AnimationState> = new Map();
    private font: opentype.Font | undefined;
    private fontLoadPromise: Promise<void> | undefined;

    private readonly START_X = 18;       
    private readonly TRIGGER_X = 72;     
    private readonly MAX_BOX_OPACITY = 0.3;
    private readonly BOLD_FACTOR = 1.03; 

    constructor() {
        this.fontLoadPromise = this.loadFont();
    }

    private async loadFont(): Promise<void> {
        const fontFileName = 'OpenSans-Bold.ttf';
        const cwd = process.cwd();
        const pathsToTry = [
            path.join(cwd, 'assets', fontFileName),
            path.join(cwd, fontFileName)
        ];

        let foundPath = '';
        for (const p of pathsToTry) {
            if (fs.existsSync(p)) {
                foundPath = p;
                break;
            }
        }

        if (!foundPath) {
            streamDeck.logger.error(`[TitleAnimator] Font not found. Searched: ${pathsToTry.join(', ')}`);
            return;
        }

        try {
            const data = fs.readFileSync(foundPath);
            const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            this.font = opentype.parse(arrayBuffer);
            streamDeck.logger.info(`[TitleAnimator] Font loaded: ${this.font.names.fontFamily?.en ?? 'OK'}`);
        } catch (err) {
            streamDeck.logger.error(`[TitleAnimator] Font parse error: ${err}`);
        }
    }

    private async measureText(text: string, fontSize: number): Promise<number> {
        await this.fontLoadPromise;
        if (this.font) {
            return this.font.getAdvanceWidth(text, fontSize) * this.BOLD_FACTOR;
        }
        return text.length * fontSize * 0.5 * this.BOLD_FACTOR;
    }

    // Public wrapper for other modules to get an accurate text width
    public async measure(text: string, fontSize: number): Promise<number> {
        return this.measureText(text, fontSize);
    }

    public isRunning(context: string): boolean {
        return this.animationStates.has(context);
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

        if (newOptions.text !== state.options.text) {
            state.options.text = newOptions.text;
            const fontSize = state.options.fontSize || 13;
            state.textWidth = await this.measureText(state.options.text, fontSize);
            state.shouldScroll = (this.START_X + state.textWidth) > this.TRIGGER_X;
            this.resetAnimationState(state);
        }
    }

    public async start(action: any, options: AnimationOptions): Promise<void> {
        const context = action.id;
        this.stop(context);

        const fontSize = options.fontSize || 13;
        const textWidth = await this.measureText(options.text || '', fontSize);
        const shouldScroll = (this.START_X + textWidth) > this.TRIGGER_X;

        const state: AnimationState = {
            action, options, offset: 0, boxOpacity: 0, textOpacity: 0,
            phase: AnimPhase.BOX_IN, pauseTicks: 0, textWidth, shouldScroll,
            isFading: false, fadeOpacity: 0
        };

        const interval = setInterval(async () => {
            const speed = state.options.speed || 1.1;
            const pauseTicksMax = state.options.pauseDuration || 40;

            if (state.isFading) {
                state.fadeOpacity += 0.1;
                if (state.fadeOpacity >= 1) {
                    state.fadeOpacity = 1;
                    state.isFading = false;
                    state.oldBackgroundImage = undefined;
                }
            }

            switch (state.phase) {
                case AnimPhase.BOX_IN:
                    state.boxOpacity += 0.05;
                    if (state.boxOpacity >= this.MAX_BOX_OPACITY) {
                        state.boxOpacity = this.MAX_BOX_OPACITY;
                        state.phase = state.shouldScroll ? AnimPhase.SCROLL_AND_FADE_IN : AnimPhase.SCROLL_OPAQUE;
                    }
                    break;

                case AnimPhase.SCROLL_AND_FADE_IN:
                    state.offset += speed;
                    state.textOpacity += 0.1;
                    if (state.textOpacity >= 1) {
                        state.textOpacity = 1;
                        state.phase = AnimPhase.SCROLL_OPAQUE;
                    }
                    break;
                
                case AnimPhase.SCROLL_OPAQUE:
                    if (state.shouldScroll) {
                        state.offset += speed;
                        const currentTailX = this.START_X - state.offset + state.textWidth;
                        if (currentTailX <= this.TRIGGER_X) {
                            state.phase = AnimPhase.SCROLL_AND_FADE_OUT;
                        }
                    } else {
                        state.textOpacity = 1;
                        state.pauseTicks++;
                        if (state.pauseTicks > pauseTicksMax) state.phase = AnimPhase.SCROLL_AND_FADE_OUT;
                    }
                    break;

                case AnimPhase.SCROLL_AND_FADE_OUT:
                    if (state.shouldScroll) state.offset += speed;
                    state.textOpacity -= 0.1;
                    if (state.textOpacity <= 0) {
                        state.textOpacity = 0;
                        state.phase = AnimPhase.BOX_OUT;
                    }
                    break;

                case AnimPhase.BOX_OUT:
                    state.boxOpacity -= 0.05;
                    if (state.boxOpacity <= 0) {
                        state.boxOpacity = 0;
                        state.phase = AnimPhase.PAUSE_LOOP;
                        state.pauseTicks = pauseTicksMax;
                    }
                    break;

                case AnimPhase.PAUSE_LOOP:
                    if (state.pauseTicks > 0) state.pauseTicks--;
                    else this.resetAnimationState(state);
                    break;
            }

            await state.action.setImage(this.renderSvg(state));
        }, options.interval || 50);

        state.intervalId = interval;
        this.animationStates.set(context, state);
    }

    private resetAnimationState(state: AnimationState) {
        state.offset = 0; state.boxOpacity = 0; state.textOpacity = 0;
        state.phase = AnimPhase.BOX_IN; state.pauseTicks = 0;
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
        const { options, offset, boxOpacity, textOpacity, isFading, oldBackgroundImage, fadeOpacity } = state;
        const fontSize = options.fontSize || 13;
        const textY = 64;
        const barY = textY - fontSize - 2;

        const textX = state.shouldScroll 
            ? (this.START_X - offset) 
            : this.START_X + ((this.TRIGGER_X - this.START_X) - state.textWidth) / 2;

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
                <rect x="0" y="${barY}" width="72" height="${fontSize + 8}" fill="black" fill-opacity="${boxOpacity}" />
                <text 
                    x="${textX}" 
                    y="${textY}" 
                    fill="${options.fontColor || 'white'}" 
                    fill-opacity="${textOpacity}" 
                    font-family="sans-serif" 
                    font-size="${fontSize}" 
                    font-weight="bold"
                >${options.text}</text>
            </svg>
        `;
        return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    }
}

export const titleAnimator = new TitleAnimator();