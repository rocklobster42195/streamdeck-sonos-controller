import { Action } from "@elgato/streamdeck";

const FADE_INTERVAL = 50; // ms
const FADE_STEP = 0.1;

interface AnimationState {
    intervalId?: NodeJS.Timeout;
    isFading: boolean;
    fadeOpacity: number;
    currentImage?: string;
    oldImage?: string;
    renderCallback: () => void;
}

export class CoverArtAnimator {
    private animationStates: Map<string, AnimationState> = new Map();

    public isRunning(context: string): boolean {
        return this.animationStates.has(context);
    }

    public updateImage(context: string, newImage: string | undefined) {
        const state = this.animationStates.get(context);
        if (!state) return;

        // Keep the current cover visible while the next one is still loading.
        if (newImage === undefined && state.currentImage) return;

        if (newImage !== state.currentImage) {
            state.oldImage = state.currentImage;
            state.currentImage = newImage;
            state.isFading = true;
            state.fadeOpacity = 0;
            this.ensureAnimationIsRunning(context);
        }
    }

    public start(context: string, renderCallback: () => void, initialImage?: string) {
        if (this.isRunning(context)) {
            this.stop(context);
        }

        const state: AnimationState = {
            isFading: false,
            fadeOpacity: 1,
            currentImage: initialImage,
            renderCallback: renderCallback
        };

        this.animationStates.set(context, state);
    }

    private ensureAnimationIsRunning(context: string) {
        const state = this.animationStates.get(context);
        if (!state || state.intervalId) {
            return;
        }

        state.intervalId = setInterval(() => {
            this.animationTick(context);
        }, FADE_INTERVAL);
    }

    private animationTick(context: string) {
        const state = this.animationStates.get(context);
        if (!state || !state.isFading) {
            this.stop(context); // Stops the interval if no longer fading
            return;
        }

        state.fadeOpacity += FADE_STEP;
        if (state.fadeOpacity >= 1) {
            state.fadeOpacity = 1;
            state.isFading = false;
            state.oldImage = undefined;
            // Animation is done, stop the interval
            this.stop(context);
        }

        // The external render function (passed during start) will be responsible for drawing
        // so we just let the interval run until the fade is complete.
        const renderCallback = this.animationStates.get(context)?.renderCallback;
        if (renderCallback) {
            renderCallback();
        }
    }

    public stop(context: string): void {
        const state = this.animationStates.get(context);
        if (state && state.intervalId) {
            clearInterval(state.intervalId);
            state.intervalId = undefined;
        }
    }

    public render(context: string, x: number, y: number, width: number, height: number): string {
        const state = this.animationStates.get(context);
        if (!state) return '';
        
        const { currentImage, oldImage, isFading, fadeOpacity } = state;

        let bgHtml = '';
        if (isFading && oldImage && currentImage) {
            // Crossfade from old to new
            bgHtml = `
                <image href="${oldImage}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="${1 - fadeOpacity}" />
                <image href="${currentImage}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="${fadeOpacity}" />
            `;
        } else if (currentImage) {
            // Just the current image
            bgHtml = `<image href="${currentImage}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" />`;
        } else {
            // Black background if no image
            bgHtml = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="black" />`;
        }

        return bgHtml;
    }

    public destroy(context: string) {
        this.stop(context);
        this.animationStates.delete(context);
    }
}
