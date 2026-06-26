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
