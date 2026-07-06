declare module 'gif-encoder-2' {
    export default class GIFEncoder {
        constructor(width: number, height: number, algorithm?: string, useOptimizer?: boolean, totalFrames?: number);
        setDelay(ms: number): void;
        setRepeat(repeat: number): void;
        setQuality(quality: number): void;
        start(): void;
        addFrame(data: Uint8ClampedArray | Uint8Array): void;
        finish(): void;
        readonly out: { getData(): Buffer };
    }
}
