// Scrolling text on the dials, drawn with the kit's marquee and counted steps (MarqueeStepper on
// the shared frame ticker): whole pixels at a fixed rhythm, and a late frame shows the next step
// instead of jumping (the time-based offset hitched now and then on hardware, 2026-10-03). The API is the one the actions always used; speed and pause keep their
// old units (pixels per 150 ms tick, ticks) so stored settings such as the Track dial's
// marqueeSpeed/marqueePause still mean the same pace.
import { frames, MarqueeStepper, marqueeNeeded, marqueeSvg, measureArialWidth } from "@rocklobster42195/streamdeck-kit";

export interface MarqueeOptions {
    text?: string;
    fontSize?: number;
    fontColor?: string;
    speed?: number; // pixels per (former) 150 ms tick
    pauseDuration?: number; // (former) 150 ms ticks to pause before scrolling
    measuredWidth?: number; // ignored: the kit measures Arial itself
    availableWidth?: number; // width of the text area to fit into
}

/** The former interval the units above refer to. */
const LEGACY_TICK_MS = 150;

interface MarqueeState {
    renderCallback?: () => void;
    text: string;
    fontSize: number;
    fontColor: string;
    speed: number;
    pauseDuration: number;
    availableWidth: number;
    stepper: MarqueeStepper;
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

    // Temporary diagnostic (2026-07-18) — see debugCallbackCounts on SonosDeviceController.
    public get activeCount(): number {
        return this.states.size;
    }

    public start(context: string, renderCallback: () => void, options?: MarqueeOptions) {
        this.stop(context);
        this.states.set(context, {
            renderCallback,
            text: options?.text ?? '',
            fontSize: options?.fontSize ?? 14,
            fontColor: options?.fontColor ?? '#FFFFFF',
            speed: options?.speed ?? 1,
            pauseDuration: options?.pauseDuration ?? 40,
            availableWidth: options?.availableWidth ?? 100,
            stepper: new MarqueeStepper(),
        });
        this.ensureTicking(context);
    }

    public update(context: string, options: MarqueeOptions) {
        const state = this.states.get(context);
        if (!state) return;
        if (options.text !== undefined && options.text !== state.text) {
            state.text = options.text;
            state.stepper.reset();
        }
        if (options.availableWidth !== undefined) state.availableWidth = options.availableWidth;
        if (options.fontSize !== undefined) state.fontSize = options.fontSize;
        if (options.fontColor !== undefined) state.fontColor = options.fontColor;
        if (options.speed !== undefined) state.speed = options.speed;
        if (options.pauseDuration !== undefined) state.pauseDuration = options.pauseDuration;
        this.ensureTicking(context);
    }

    public render(context: string, x: number, y: number, width: number, _height: number): string {
        const state = this.states.get(context);
        if (!state) return '';
        return marqueeSvg({
            id: this.getClipId(context),
            text: state.text,
            x,
            y,
            width,
            fontSize: state.fontSize,
            color: state.fontColor,
            startedAt: 0,
            now: 0,
            offset: this.offset(state),
        });
    }

    public stop(context: string) {
        frames.stop(this.tickerId(context));
    }

    public destroy(context: string) {
        this.stop(context);
        this.states.delete(context);
    }

    private ensureTicking(context: string) {
        const state = this.states.get(context);
        if (!state?.renderCallback || !marqueeNeeded(state.text, state.fontSize, state.availableWidth)) {
            this.stop(context);
            return;
        }
        frames.run(this.tickerId(context), () => {
            const s = this.states.get(context);
            if (!s?.renderCallback || !marqueeNeeded(s.text, s.fontSize, s.availableWidth)) return false;
            s.stepper.tick();
            s.renderCallback();
            return true;
        });
    }

    private offset(s: MarqueeState): number {
        s.stepper.speed = (s.speed * 1000) / LEGACY_TICK_MS;
        s.stepper.pauseMs = s.pauseDuration * LEGACY_TICK_MS;
        return s.stepper.offset(measureArialWidth(s.text, s.fontSize));
    }

    private tickerId(context: string): string {
        return `marquee-${context}`;
    }
}

export const marqueeAnimator = new MarqueeAnimator();
