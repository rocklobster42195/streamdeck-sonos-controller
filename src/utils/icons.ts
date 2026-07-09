// SVG icon generators — 24×24 viewBox, returned as base64 data URIs.
// Paths are pulled directly from @mdi/js (pictogrammers.com), MIT licensed.

import {
    mdiPlayCircle,
    mdiTimerSand,
    mdiSkipNext,
    mdiSkipPrevious,
    mdiShuffle,
    mdiRepeat,
    mdiRepeatOnce,
    mdiVolumeHigh,
    mdiVolumeMedium,
    mdiVolumeLow,
    mdiVolumeOff,
    mdiVolumePlus,
    mdiVolumeMinus,
    mdiTuneVertical,
    mdiCog,
} from '@mdi/js';

function svgUri(path: string, color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// --- Transport (Play/Pause Key) ---

export function generateTransportIcon(state: 'play' | 'loading', color = '#CCCCCC'): string {
    return svgUri(state === 'loading' ? mdiTimerSand : mdiPlayCircle, color);
}

// --- Playback Control ---

export function generatePlaybackIcon(
    type: 'next' | 'previous' | 'shuffle' | 'repeat',
    active: boolean | 'all' | 'one' | 'off' = false,
    color = '#CCCCCC',
    dimColor = '#555555'
): string {
    switch (type) {
        case 'next':     return svgUri(mdiSkipNext, color);
        case 'previous': return svgUri(mdiSkipPrevious, color);
        case 'shuffle':  return svgUri(mdiShuffle, active ? color : dimColor);
        case 'repeat':
            if (active === 'one') return svgUri(mdiRepeatOnce, color);
            if (active === 'all' || active === true) return svgUri(mdiRepeat, color);
            return svgUri(mdiRepeat, dimColor);
    }
}

// --- Volume Key ---

export function generateVolumeButtonIcon(type: 'up' | 'down' | 'preset', color = '#CCCCCC'): string {
    switch (type) {
        case 'up':     return svgUri(mdiVolumePlus, color);
        case 'down':   return svgUri(mdiVolumeMinus, color);
        case 'preset': return svgUri(mdiTuneVertical, color);
    }
}

// --- Volume level (Dial Volume icon field) ---

export function generateVolumeLevelIcon(volume: number, muted: boolean, color = '#CCCCCC'): string {
    if (muted)       return svgUri(mdiVolumeOff, color);
    if (volume < 10) return svgUri(mdiVolumeLow, color);
    if (volume < 60) return svgUri(mdiVolumeMedium, color);
    return svgUri(mdiVolumeHigh, color);
}

// --- Dial "not configured yet" placeholder ---
// Shared across dial actions' full-canvas feedback so a missing PI setting (device/group)
// reads clearly on the low-res dial screen instead of blending into the background.
export function buildUnconfiguredDialSvg(label: string): string {
    const cx = 100, cy = 38, rOuter = 18;
    const scale = (rOuter * 2) / 24;
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        '<rect width="200" height="100" fill="#0a0a0a"/>',
        `<g transform="translate(${cx - rOuter},${cy - rOuter}) scale(${scale})"><path fill="#7A7A7A" d="${mdiCog}"/></g>`,
        `<text x="${cx}" y="80" fill="#8A8A8A" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" letter-spacing="1.5">${label}</text>`,
        '</svg>',
    ].join('');
}
