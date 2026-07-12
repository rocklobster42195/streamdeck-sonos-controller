import { describe, it, expect } from 'vitest';
import { mdiVolumeHigh, mdiVolumeMedium, mdiVolumeLow, mdiVolumeOff, mdiCog, mdiSpeakerOff } from '@mdi/js';
import { generateVolumeLevelIcon, buildUnconfiguredDialSvg, buildUnreachableDialSvg, generateUnreachableKeyIcon, INACTIVE_ICON_COLOR } from './icons';

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
