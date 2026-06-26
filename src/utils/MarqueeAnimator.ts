export interface MarqueeOptions {
    text?: string;
    fontSize?: number;
    fontColor?: string;
    speed?: number; // pixels per tick
    pauseDuration?: number; // ticks to pause at start before scrolling
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

        state.intervalId = setInterval(() => {
            if (state.pauseTicks < state.pauseDuration) {
                state.pauseTicks++;
            } else {
                state.offset += state.speed;
                // Prevent integer overflow in very long sessions.
                const cycleWidth = Math.max(1, state.width + state.availableWidth);
                if (state.offset > cycleWidth * 5000) {
                    state.offset = state.offset % cycleWidth;
                }
            }

            if (state.renderCallback) {
                state.renderCallback();
            }
        }, 80);
    }

    public render(context: string, x: number, y: number, width: number, height: number): string {
        const state = this.states.get(context);
        if (!state) return '';

        const fontSize = state.fontSize;
        const text = this.escapeXml(state.text || '');
        const clipId = this.getClipId(context);

        if (!state.shouldScroll) {
            return `
                <defs>
                  <clipPath id="${clipId}"><rect x="${x}" y="${y - fontSize - 2}" width="${width}" height="${height + fontSize + 4}"/></clipPath>
                </defs>
                <text x="${x}" y="${y}" fill="${state.fontColor}" font-family="Arial, sans-serif" font-size="${fontSize}" clip-path="url(#${clipId})">${text}</text>
            `;
        }

        // Small gap between copies so the next copy enters before the current one has fully exited.
        // cycleWidth < textWidth + availableWidth means both copies are briefly visible simultaneously.
        const GAP = 25;
        const cycleWidth = Math.max(1, state.width + GAP);
        const effectiveOffset = state.offset % cycleWidth;
        const tx1 = x - effectiveOffset;
        const tx2 = x - effectiveOffset + cycleWidth;

        // Right-side fade only — left boundary is the hard mask edge at x (same as artist indent).
        const fadeW = 12;
        const fadeStartPct = Math.round(((width - fadeW) / width) * 100);
        const gradId = `${clipId}g`;
        const maskId = `${clipId}m`;

        return `
            <defs>
              <linearGradient id="${gradId}" x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stop-color="white" stop-opacity="1"/>
                <stop offset="${fadeStartPct}%" stop-color="white" stop-opacity="1"/>
                <stop offset="100%" stop-color="white" stop-opacity="0"/>
              </linearGradient>
              <mask id="${maskId}">
                <rect x="${x}" y="${y - fontSize - 2}" width="${width}" height="${height + fontSize + 4}" fill="url(#${gradId})"/>
              </mask>
            </defs>
            <g mask="url(#${maskId})">
              <text x="${tx1}" y="${y}" fill="${state.fontColor}" font-family="Arial, sans-serif" font-size="${fontSize}">${text}</text>
              <text x="${tx2}" y="${y}" fill="${state.fontColor}" font-family="Arial, sans-serif" font-size="${fontSize}">${text}</text>
            </g>
        `;
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
        const factor = 0.55;
        const padding = 4;
        return Math.max(0, Math.ceil(text.length * fontSize * factor) + padding);
    }

    private escapeXml(unsafe: string): string {
        return unsafe.replace(/[<>&"']/g, (c) => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":"&apos;" } as any)[c] || c);
    }
}

export const marqueeAnimator = new MarqueeAnimator();
