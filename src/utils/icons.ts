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
    mdiSpeakerOff,
    mdiBattery,
    mdiBatteryOutline,
    mdiBatteryAlert,
    mdiBattery10,
    mdiBattery20,
    mdiBattery30,
    mdiBattery40,
    mdiBattery50,
    mdiBattery60,
    mdiBattery70,
    mdiBattery80,
    mdiBattery90,
    mdiBatteryChargingOutline,
    mdiBatteryCharging100,
    mdiBatteryCharging10,
    mdiBatteryCharging20,
    mdiBatteryCharging30,
    mdiBatteryCharging40,
    mdiBatteryCharging50,
    mdiBatteryCharging60,
    mdiBatteryCharging70,
    mdiBatteryCharging80,
    mdiBatteryCharging90,
    mdiAudioInputRca,
} from '@mdi/js';

function svgUri(path: string, color: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// --- Transport (Play/Pause Key) ---

export function generateTransportIcon(state: 'play' | 'loading', color = '#CCCCCC', batteryBadge = ''): string {
    const path = state === 'loading' ? mdiTimerSand : mdiPlayCircle;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/>${batteryBadge}</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Wraps an already-rendered raster/data-URI image (e.g. Sonos cover art) in an SVG so overlay
// fragments (battery badge, progress bar, ...) can be composited on top — returns the image
// untouched when there's nothing to overlay, avoiding the extra SVG wrap for the common case
// (most Sonos speakers are mains-powered, most keys don't opt into the progress bar).
export function wrapImageWithBadge(imageDataUri: string, overlay: string, size = 72): string {
    if (!overlay) return imageDataUri;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
        `<image href="${imageDataUri}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice"/>${overlay}</svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// --- Progress bar (Play/Pause key, opt-in via PI "Progress bar") ---

// Thin rounded bar sitting in the leftover space below TitleAnimator's title box (which stays
// fixed regardless of this bar — see its own textY comment: box bottom edge is at textY+6, i.e.
// 66px at size=72, leaving 6px above the key's own bottom edge). That leftover space is split
// evenly around the bar — gap above (box→bar) equal to the gap below (bar→edge) — rather than
// flush against either. Dim track always visible once a duration is known, filled portion in
// `color` (the cover's dominant color, so it reads as part of the artwork rather than generic UI
// chrome). Carries its own small dark backing pill — cover art is unpredictable (light/busy
// backgrounds happen), and the fill color comes from that same cover, so without a
// guaranteed-dark backdrop a light dominant color can end up with no real contrast against either
// the track or the artwork behind it. `progress` undefined means no track/duration known yet —
// same "nothing to show" contract as renderBatteryBadge.
export function renderProgressBar(progress: number | undefined, color: string, size = 72): string {
    if (progress === undefined) return '';
    const margin = Math.round(size * 0.04);
    const height = Math.max(2, Math.round(size * 0.045));
    const boxBottom = size - Math.round(size * 0.083); // 66 @ 72 — mirrors TitleAnimator's textY+6
    const gap = Math.max(0, (size - boxBottom - height) / 2);
    const y = boxBottom + gap;
    const width = size - margin * 2;
    const fillW = Math.round(width * Math.min(1, Math.max(0, progress)));
    const pad = 1;
    return [
        `<rect x="${margin - pad}" y="${y - pad}" width="${width + pad * 2}" height="${height + pad * 2}" rx="${(height + pad * 2) / 2}" fill="#000000" fill-opacity="0.55"/>`,
        `<rect x="${margin}" y="${y}" width="${width}" height="${height}" rx="${height / 2}" fill="#ffffff" fill-opacity="0.3"/>`,
        fillW > 0 ? `<rect x="${margin}" y="${y}" width="${fillW}" height="${height}" rx="${height / 2}" fill="${ensureBarVisible(color)}"/>` : '',
    ].join('');
}

// A dominant cover color often lands in a "technically not black, not white" mid-range that a
// generic luminance-≥0.25 boost (see ensureVisibleColor in the dial actions) leaves untouched —
// fine for tinting a large area, but at this bar's ~3px height that whole mid-range reads as
// "same as the dark backing" and "same as the dim white track" simultaneously. Boost to a much
// higher luminance floor computed exactly (not a fixed blend amount) so it lands where intended
// regardless of how dark or already-bright the source color was.
function ensureBarVisible(color: string): string {
    const m = color.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if (!m) return '#e6e6e6';
    const [r, g, b] = [+m[1], +m[2], +m[3]];
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    const target = 0.62;
    if (lum >= target) return color;
    const f = (target - lum) / (1 - lum);
    const mix = (v: number) => Math.round(v + (255 - v) * f);
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

// --- Playback Control ---

export function generatePlaybackIcon(
    type: 'next' | 'previous' | 'shuffle' | 'repeat',
    active: boolean | 'all' | 'one' | 'off' = false,
    color = '#CCCCCC',
    dimColor = OFF_ICON_COLOR
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

// --- Line-In (MultiControlKey "Line-In" function) ---

export function generateLineInIcon(color = '#CCCCCC'): string {
    return svgUri(mdiAudioInputRca, color);
}

// --- Volume level (Dial Volume icon field) ---

export function generateVolumeLevelIcon(volume: number, muted: boolean, color = '#CCCCCC'): string {
    if (muted)       return svgUri(mdiVolumeOff, color);
    if (volume < 10) return svgUri(mdiVolumeLow, color);
    if (volume < 60) return svgUri(mdiVolumeMedium, color);
    return svgUri(mdiVolumeHigh, color);
}

// --- Battery mini-badge (Track Dial corner icon, PlayPause toggle overlay) ---

const BATTERY_LEVEL_PATHS: Record<number, string> = {
    0: mdiBatteryOutline, 10: mdiBattery10, 20: mdiBattery20, 30: mdiBattery30, 40: mdiBattery40,
    50: mdiBattery50, 60: mdiBattery60, 70: mdiBattery70, 80: mdiBattery80, 90: mdiBattery90, 100: mdiBattery,
};
const BATTERY_CHARGING_PATHS: Record<number, string> = {
    0: mdiBatteryChargingOutline, 10: mdiBatteryCharging10, 20: mdiBatteryCharging20, 30: mdiBatteryCharging30,
    40: mdiBatteryCharging40, 50: mdiBatteryCharging50, 60: mdiBatteryCharging60, 70: mdiBatteryCharging70,
    80: mdiBatteryCharging80, 90: mdiBatteryCharging90, 100: mdiBatteryCharging100,
};

export const BATTERY_LOW_THRESHOLD_PERCENT = 20;

/** Picks an MDI battery glyph + color for a given level/charging state.
 *  'warning' mode always returns the alert glyph (mdiBatteryAlert) — callers only use it once a
 *  device's level is already at/below BATTERY_LOW_THRESHOLD_PERCENT, so no level detail is drawn.
 *  'full' mode returns a level-bucketed glyph (nearest 10%), charging variant when
 *  battery.charging is true. Sonos does not report whether a charge is wireless or cable
 *  (confirmed on hardware — see SonosBattery.ts), so there is exactly one charging glyph. */
function pickBatteryIcon(mode: 'warning' | 'full', battery: { percent: number; charging: boolean }): { path: string; color: string } {
    if (mode === 'warning') return { path: mdiBatteryAlert, color: '#FF4D4D' };
    const bucket = Math.max(0, Math.min(100, Math.round(battery.percent / 10) * 10));
    const path = battery.charging ? BATTERY_CHARGING_PATHS[bucket] : BATTERY_LEVEL_PATHS[bucket];
    // Color decision uses the raw percent, not the 10%-rounded bucket above (that bucket only
    // exists because MDI's battery glyphs come in 10% steps) — otherwise e.g. 54% rounds to
    // bucket 50 and reads as still-orange, one tier below where the user actually is. Plugin-wide:
    // this is the single shared color source for both the mini-badge and the full-key display.
    const color = battery.percent <= BATTERY_LOW_THRESHOLD_PERCENT ? '#FF4D4D' : battery.percent < 50 ? '#FFC24D' : '#4DDB6E';
    return { path, color };
}

/** Renders a battery mini-badge (bare MDI glyph, no backdrop) as an SVG fragment to embed at
 *  (x, y) in a `size`×`size` box within a parent SVG. Returns '' when nothing should be shown:
 *  no battery data, mode is 'off'/undefined, or mode is 'warning' and the level isn't low. Shared
 *  by Track Dial (canvas corner badge) and the PlayPause toggle key (icon/cover/title overlay). */
export function renderBatteryBadge(
    mode: 'off' | 'warning' | 'full' | undefined,
    battery: { percent: number; charging: boolean } | undefined,
    x: number, y: number, size: number,
): string {
    if (!battery || !mode || mode === 'off') return '';
    const isLow = battery.percent <= BATTERY_LOW_THRESHOLD_PERCENT;
    if (mode === 'warning' && !isLow) return '';

    const { path, color } = pickBatteryIcon(mode, battery);
    const scale = size / 24;

    return `<g transform="translate(${x},${y}) scale(${scale})"><path fill="${color}" d="${path}"/></g>`;
}

// --- Battery full-key display (MultiControlKey "Battery" function) ---
// Dedicates the whole key face to the reading, unlike renderBatteryBadge's small corner overlay.
// Reuses pickBatteryIcon's color/glyph decision — always 'full' mode here, since a whole key given
// over to battery should show the real level, not just a low-battery warning glyph.
export function generateBatteryKeyIcon(battery: { percent: number; charging: boolean } | undefined, size = 72): string {
    if (!battery) return generateUnreachableKeyIcon();
    const { path, color } = pickBatteryIcon('full', battery);
    const iconSize = Math.round(size * 0.5);
    const iconX = (size - iconSize) / 2;
    const iconY = size * 0.12;
    const scale = iconSize / 24;
    const fontSize = Math.round(size * 0.19);
    const textY = size * 0.86;
    const svg = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
        `<g transform="translate(${iconX},${iconY}) scale(${scale})"><path fill="${color}" d="${path}"/></g>`,
        `<text x="${size / 2}" y="${textY}" fill="${color}" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" text-anchor="middle">${Math.round(battery.percent)}%</text>`,
        '</svg>',
    ].join('');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// --- "Not available" states (unconfigured / unreachable / disabled control) ---
// ONE shared color for everything in the "this control can't do anything right now" category,
// plugin-wide: the unconfigured cog, the unreachable speaker-off, AND the disabled transport
// glyphs (e.g. Next/Previous while a radio station is playing, which can't skip). The glyph
// tells you WHY it's unavailable; the color only says THAT it's unavailable — deliberately
// darker than the operable-but-off state (#555555) and far darker than any active icon
// (#CCCCCC), so none of these ever read as an operable button. Tuned on hardware in two rounds:
// #252525 was too dark to make out at all, #3A3A3A still a touch too dark.
export const INACTIVE_ICON_COLOR = '#454545';

// "Operable but currently off" (e.g. Shuffle/Repeat disengaged): the middle tier of the icon
// state scale — brighter than INACTIVE_ICON_COLOR (pressing this DOES something), well below
// active #CCCCCC. Was #555555; raised to keep visible separation from the not-available tier.
export const OFF_ICON_COLOR = '#666666';

function buildDialStatusSvg(glyphPath: string, label: string): string {
    const cx = 100, cy = 38, rOuter = 18;
    const scale = (rOuter * 2) / 24;
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">',
        '<rect width="200" height="100" fill="#0a0a0a"/>',
        `<g transform="translate(${cx - rOuter},${cy - rOuter}) scale(${scale})"><path fill="${INACTIVE_ICON_COLOR}" d="${glyphPath}"/></g>`,
        `<text x="${cx}" y="80" fill="#555555" font-family="Arial,sans-serif" font-size="11" text-anchor="middle" letter-spacing="1.5">${label}</text>`,
        '</svg>',
    ].join('');
}

export function buildUnconfiguredDialSvg(label: string): string {
    return buildDialStatusSvg(mdiCog, label);
}

export function buildUnreachableDialSvg(label: string): string {
    return buildDialStatusSvg(mdiSpeakerOff, label);
}

// Key-sized variant for the button actions (Play/Pause, Volume, Playback Control, Favorite).
export function generateUnreachableKeyIcon(): string {
    return svgUri(mdiSpeakerOff, INACTIVE_ICON_COLOR);
}
