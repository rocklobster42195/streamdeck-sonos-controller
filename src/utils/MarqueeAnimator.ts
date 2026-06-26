export interface MarqueeOptions {
    text?: string;
    fontSize?: number;
    fontColor?: string;
    speed?: number; // pixels per tick
    pauseDuration?: number; // ticks to pause at start/end
    measuredWidth?: number; // optional precise measurement
    availableWidth?: number; // width of the text area to fit into
}

interface MarqueeState {
    intervalId?: NodeJS.Timeout;
    renderCallback?: () => void;
    offset: number;
    text: string;
    width: number;
    shouldScroll: boolean;
    fontSize: number;
    fontColor: string;
    speed: number;
    pauseTicks: number;
    pauseDuration: number;
    availableWidth: number;
}

export class MarqueeAnimator {
    private states: Map<string, MarqueeState> = new Map();

    public getClipId(context: string): string {
        const safe = context.replace(/[^a-zA-Z0-9_-]/g, '_');
        return `marqueeClip${safe}`;
    }

    public isRunning(context: string): boolean {
        return this.states.has(context);
    }

    public start(context: string, renderCallback: () => void, options?: MarqueeOptions) {
        this.stop(context);
        const text = options?.text ?? '';
        const fontSize = options?.fontSize ?? 14;
        const fontColor = options?.fontColor ?? '#FFFFFF';
        const speed = options?.speed ?? 1;
        const pauseDuration = options?.pauseDuration ?? 40;

        const width = options?.measuredWidth ?? this.estimateTextWidth(text, fontSize);
        const availableWidth = options?.availableWidth ?? 100;
        const shouldScroll = width > availableWidth;

        const state: MarqueeState = {
            renderCallback,
            offset: 0,
            text,
            width,
            shouldScroll,
            fontSize,
            fontColor,
            speed,
            pauseTicks: 0,
            pauseDuration,
            availableWidth
        };

        this.states.set(context, state);

        if (shouldScroll) this.ensureInterval(context);
    }

    public update(context: string, options: MarqueeOptions) {
        const state = this.states.get(context);
        if (!state) return;
        if (options.text !== undefined) {
            state.text = options.text;
            state.width = options.measuredWidth ?? this.estimateTextWidth(state.text, options.fontSize ?? state.fontSize);
            state.availableWidth = options.availableWidth ?? state.availableWidth ?? 100;
            state.shouldScroll = state.width > state.availableWidth;
            state.offset = 0;
            state.pauseTicks = 0;
        }
        if (options.fontSize !== undefined) state.fontSize = options.fontSize;
        if (options.fontColor !== undefined) state.fontColor = options.fontColor;
        if (options.speed !== undefined) state.speed = options.speed;
        if (options.pauseDuration !== undefined) state.pauseDuration = options.pauseDuration;

        if (state.shouldScroll && state.renderCallback) this.ensureInterval(context);
        else this.stop(context);
    }

    private ensureInterval(context: string) {
        const state = this.states.get(context);
        if (!state) return;
        if (state.intervalId) return;

        let tickCount = 0;
        state.intervalId = setInterval(() => {
            tickCount++;
            // recompute maxOffset each tick in case text/available width changed
            const maxOffset = Math.max(0, state.width - state.availableWidth);

            // simple pause at ends
            if (state.pauseTicks < state.pauseDuration) {
                state.pauseTicks++;
            } else {
                state.offset += state.speed;
                if (state.offset > maxOffset) {
                    // reset to start (no overshoot beyond the left start position)
                    state.offset = 0;
                    state.pauseTicks = 0;
                }
            }

            // ensure offset is always clamped to valid range
            if (state.offset < 0) state.offset = 0;
            if (state.offset > maxOffset) state.offset = maxOffset;

            // Log every 10th tick to avoid spam
            if (tickCount % 10 === 0) {
                console.log(`[MarqueeAnimator] tick=${tickCount}, offset=${state.offset}, width=${state.width}, maxOffset=${maxOffset}, shouldScroll=${state.shouldScroll}`);
            }

            if (state.renderCallback) {
                state.renderCallback();
            } else {
                console.warn(`[MarqueeAnimator] No renderCallback for context ${context}`);
            }
        }, 80);

        console.log(`[MarqueeAnimator] Interval started for context ${context}, shouldScroll=${state.shouldScroll}, width=${state.width}, available=${state.availableWidth}`);
    }

    public render(context: string, x: number, y: number, width: number, height: number): string {
        const state = this.states.get(context);
        if (!state) return '';

        const fontSize = state.fontSize;
        const text = this.escapeXml(state.text || '');
        const clipId = this.getClipId(context);

        if (!state.shouldScroll) {
            // static text, starts at left edge (x) with no extra padding
            return `
                <defs>
                  <clipPath id="${clipId}"><rect x="${x}" y="${y - fontSize}" width="${width}" height="${height}" /></clipPath>
                </defs>
                <text x="${x}" y="${y}" fill="${state.fontColor}" font-family="Arial, sans-serif" font-size="${fontSize}" clip-path="url(#${clipId})">${text}</text>
            `;
        }

                // scrolling: draw a single text element that moves left by at most maxOffset
                // This avoids showing letters left of the start position when the animation resets.
                const tx = x - state.offset;
                const svg = `
                        <defs>
                            <clipPath id="${clipId}"><rect x="${x}" y="${y - fontSize}" width="${width}" height="${height}" /></clipPath>
                        </defs>
                        <g clip-path="url(#${clipId})">
                            <text x="${tx}" y="${y}" fill="${state.fontColor}" font-family="Arial, sans-serif" font-size="${fontSize}">${text}</text>
                        </g>
                `;
                return svg;
    }

    public stop(context: string) {
        const state = this.states.get(context);
        if (state && state.intervalId) {
            clearInterval(state.intervalId);
            state.intervalId = undefined;
        }
    }

    public destroy(context: string) {
        this.stop(context);
        this.states.delete(context);
    }

    private estimateTextWidth(text: string, fontSize: number): number {
        // conservative estimate so long titles trigger scrolling reliably
        const factor = 0.55;
        const padding = 4;
        return Math.max(0, Math.ceil(text.length * fontSize * factor) + padding);
    }

    private escapeXml(unsafe: string): string {
        return unsafe.replace(/[<>&"']/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&apos;" } as any)[c] || c);
    }
}

export const marqueeAnimator = new MarqueeAnimator();
