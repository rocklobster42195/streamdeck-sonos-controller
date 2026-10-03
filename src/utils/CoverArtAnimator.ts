// Cover crossfade on the dials, with the kit's CoverFader (smooth crossfade on the shared frame
// ticker). The covers come in as data URIs from this plugin's own loading; this class keeps the API
// the dials use and the drawing the Stream Deck renderer needs (see render()).
import { CoverFader } from "@rocklobster42195/streamdeck-kit";

interface AnimationState {
    image?: string;
    renderCallback: () => void;
}

export class CoverArtAnimator {
    private readonly fader = new CoverFader();
    private animationStates: Map<string, AnimationState> = new Map();

    public isRunning(context: string): boolean {
        return this.animationStates.has(context);
    }

    public updateImage(context: string, newImage: string | undefined) {
        const state = this.animationStates.get(context);
        if (!state) return;
        // Keep the current cover visible while the next one is still loading.
        if (newImage === undefined && state.image) return;
        if (newImage === state.image) return;
        state.image = newImage;
        state.renderCallback(); // the next frame() starts the crossfade
    }

    // Sets the displayed image directly, bypassing the crossfade entirely — for callers that
    // already know the correct image and don't want a transition from whatever was showing before
    // (e.g. Queue Dial cutting back to its resting view after a Push commit).
    public setImageInstant(context: string, newImage: string | undefined): void {
        const state = this.animationStates.get(context);
        if (!state) return;
        state.image = newImage;
        this.fader.forget(context);
    }

    public start(context: string, renderCallback: () => void, initialImage?: string) {
        this.fader.forget(context);
        this.animationStates.set(context, { image: initialImage, renderCallback });
    }

    public stop(context: string): void {
        this.fader.forget(context);
    }

    public render(context: string, x: number, y: number, width: number, height: number, anchor: 'center' | 'left' | 'right' = 'center'): string {
        const state = this.animationStates.get(context);
        if (!state) return '';
        const { cover, previous, mix } = state.image
            ? this.fader.frame(context, state.image, state.renderCallback)
            : { cover: undefined, previous: undefined, mix: 1 };

        // Manual "slice" crop instead of relying on preserveAspectRatio: Stream Deck's own SVG
        // renderer does NOT honor preserveAspectRatio on embedded <image> data URIs — it stretches
        // to exactly the given width/height, distorting non-square boxes. Album art is effectively
        // always square, so the <image> is a square matching the LARGER of width/height, laid over
        // the box, and the caller's own clipPath (sized to the visible box) crops the overflow.
        //
        // `anchor` picks WHICH part of the square the box shows: 'center' splits the overflow
        // evenly, 'left'/'right' pin the square to that edge of the box (Queue Dial's edge-flush
        // cover slots, where the centered variant shifted the artwork off the canvas edge).
        const size = Math.max(width, height);
        const imgX = anchor === 'left' ? x
            : anchor === 'right' ? x + width - size
            : x - (size - width) / 2;
        const imgY = y - (size - height) / 2;
        const img = (href: string, opacity?: number) =>
            `<image href="${href}" x="${imgX}" y="${imgY}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice"${opacity === undefined ? '' : ` opacity="${opacity.toFixed(3)}"`} />`;

        if (cover && previous) return img(previous, 1 - mix) + img(cover, mix);
        if (cover) return img(cover);
        return `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="black" />`;
    }

    public destroy(context: string) {
        this.fader.forget(context);
        this.animationStates.delete(context);
    }
}
