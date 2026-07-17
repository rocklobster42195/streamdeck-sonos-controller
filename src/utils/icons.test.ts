import { describe, it, expect } from 'vitest';
import { mdiVolumeHigh, mdiVolumeMedium, mdiVolumeLow, mdiVolumeOff, mdiCog, mdiSpeakerOff } from '@mdi/js';
import { generateVolumeLevelIcon, generateFaderSvg, buildUnconfiguredDialSvg, buildUnreachableDialSvg, generateUnreachableKeyIcon, INACTIVE_ICON_COLOR } from './icons';

function decodedPath(dataUri: string): string {
  const base64 = dataUri.replace('data:image/svg+xml;base64,', '');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

describe('generateVolumeLevelIcon', () => {
  it('shows the muted icon whenever muted is true, regardless of volume', () => {
    expect(decodedPath(generateVolumeLevelIcon(80, true))).toContain(mdiVolumeOff);
  });

  it('shows the low icon below 10', () => {
    expect(decodedPath(generateVolumeLevelIcon(0, false))).toContain(mdiVolumeLow);
    expect(decodedPath(generateVolumeLevelIcon(9, false))).toContain(mdiVolumeLow);
  });

  it('shows the medium icon from 10 up to (not including) 60', () => {
    expect(decodedPath(generateVolumeLevelIcon(10, false))).toContain(mdiVolumeMedium);
    expect(decodedPath(generateVolumeLevelIcon(59, false))).toContain(mdiVolumeMedium);
  });

  it('shows the high icon from 60 upward', () => {
    expect(decodedPath(generateVolumeLevelIcon(60, false))).toContain(mdiVolumeHigh);
    expect(decodedPath(generateVolumeLevelIcon(100, false))).toContain(mdiVolumeHigh);
  });
});

describe('buildUnconfiguredDialSvg', () => {
  it('renders the gear icon and the given label', () => {
    const svg = buildUnconfiguredDialSvg('GROUP');
    expect(svg).toContain(mdiCog);
    expect(svg).toContain('>GROUP<');
  });
});

describe('buildUnreachableDialSvg', () => {
  it('renders the speaker-off icon and the given label', () => {
    const svg = buildUnreachableDialSvg('QUEUE');
    expect(svg).toContain(mdiSpeakerOff);
    expect(svg).toContain('>QUEUE<');
  });

  it('differs from the unconfigured state by glyph, shares the same inactive color', () => {
    const unreachable = buildUnreachableDialSvg('X');
    const unconfigured = buildUnconfiguredDialSvg('X');
    expect(unreachable).not.toContain(mdiCog);
    expect(unconfigured).not.toContain(mdiSpeakerOff);
    // Both belong to the same "not available" category — one shared color, plugin-wide,
    // matching the disabled Next/Previous glyphs while a radio station plays.
    expect(unreachable).toContain(INACTIVE_ICON_COLOR);
    expect(unconfigured).toContain(INACTIVE_ICON_COLOR);
  });
});

describe('generateUnreachableKeyIcon', () => {
  it('renders the speaker-off glyph in the shared inactive color', () => {
    const svg = decodedPath(generateUnreachableKeyIcon());
    expect(svg).toContain(mdiSpeakerOff);
    expect(svg).toContain(INACTIVE_ICON_COLOR);
  });
});

describe('generateFaderSvg', () => {
  it('renders the mute icon when isMuted is true, regardless of level', () => {
    const svg = decodedPath(generateFaderSvg(50, true, '#fff'));
    expect(svg).toContain('M12,4L9.91,6.09L12,8.18');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('renders a full inner circle at 100%', () => {
    const svg = decodedPath(generateFaderSvg(100, false, '#fff'));
    expect(svg).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
  });

  it('renders no pie slice at 0%', () => {
    const svg = decodedPath(generateFaderSvg(0, false, '#fff'));
    expect(svg).not.toContain('<path d="M 12 12');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('clamps levels above 100 and below 0', () => {
    const over = decodedPath(generateFaderSvg(150, false, '#fff'));
    const under = decodedPath(generateFaderSvg(-20, false, '#fff'));
    expect(over).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
    expect(under).not.toContain('<path d="M 12 12');
  });

  it('uses the large-arc-flag once the slice passes 180 degrees', () => {
    const svg = decodedPath(generateFaderSvg(75, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 1 1/);
  });

  it('does not use the large-arc-flag below 180 degrees', () => {
    const svg = decodedPath(generateFaderSvg(25, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 0 1/);
  });

  it('always draws the outer ring', () => {
    const svg = decodedPath(generateFaderSvg(42, false, '#abc'));
    expect(svg).toContain('<circle cx="12" cy="12" r="9" stroke="#abc" stroke-width="1.5" fill="none"/>');
  });
});
