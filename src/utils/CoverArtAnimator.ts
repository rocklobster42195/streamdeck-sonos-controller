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

    // Sets the displayed image directly, bypassing the crossfade entirely — for callers that
    // already know the correct image and don't want a transition from whatever was showing before
    // (e.g. Queue Dial cutting back to its resting view after a Push commit).
    public setImageInstant(context: string, newImage: string | undefined): void {
        const state = this.animationStates.get(context);
        if (!state) return;
        state.currentImage = newImage;
        state.oldImage = undefined;
        state.isFading = false;
        this.stop(context);
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

    public render(context: string, x: number, y: number, width: number, height: number, anchor: 'center' | 'left' | 'right' = 'center'): string {
        const state = this.animationStates.get(context);
        if (!state) return '';

        const { currentImage, oldImage, isFading, fadeOpacity } = state;

        // Manual "slice" crop instead of relying on preserveAspectRatio: Stream Deck's own SVG
        // renderer visibly does NOT honor preserveAspectRatio on embedded <image> data URIs — it
        // stretches to exactly the given width/height instead, distorting non-square target boxes
        // (confirmed by the user: went unnoticed at the old near-square 87x92 cover box, but a
        // visible horizontal squish appeared once the box became a taller 87x100 for the full-
        // bleed cover). Album art is effectively always square, so instead we size the <image> to
        // a square matching the LARGER of width/height, laid over the target box, and let the
        // caller's own clipPath (already sized to the visible box) crop the overflow via SVG
        // clipping — which the renderer does respect — rather than via an aspect-ratio hint it
        // ignores.
        //
        // `anchor` picks WHICH part of the square the box shows: 'center' splits the overflow
        // evenly (the classic centered crop), while 'left'/'right' pin the square to that edge of
        // the box so the image starts exactly at the box's own origin — used by Queue Dial's
        // edge-flush cover slots, where the centered variant visibly shifted the artwork off the
        // canvas edge.
        const size = Math.max(width, height);
        const imgX = anchor === 'left' ? x
            : anchor === 'right' ? x + width - size
            : x - (size - width) / 2;
        const imgY = y - (size - height) / 2;

        let bgHtml = '';
        if (isFading && oldImage && currentImage) {
            // Crossfade from old to new
            bgHtml = `
                <image href="${oldImage}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" opacity="${1 - fadeOpacity}" />
                <image href="${currentImage}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" opacity="${fadeOpacity}" />
            `;
        } else if (currentImage) {
            // Just the current image
            bgHtml = `<image href="${currentImage}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" />`;
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
