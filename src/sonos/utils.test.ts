import { describe, it, expect } from 'vitest';
import { generateFaderSvg } from './utils';

function decodeSvg(dataUri: string): string {
  const base64 = dataUri.replace('data:image/svg+xml;base64,', '');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

describe('generateFaderSvg', () => {
  it('renders the mute icon when isMuted is true, regardless of level', () => {
    const svg = decodeSvg(generateFaderSvg(50, true, '#fff'));
    expect(svg).toContain('M12,4L9.91,6.09L12,8.18');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('renders a full inner circle at 100%', () => {
    const svg = decodeSvg(generateFaderSvg(100, false, '#fff'));
    expect(svg).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
  });

  it('renders no pie slice at 0%', () => {
    const svg = decodeSvg(generateFaderSvg(0, false, '#fff'));
    expect(svg).not.toContain('<path d="M 12 12');
    expect(svg).not.toContain('<circle cx="12" cy="12" r="7"');
  });

  it('clamps levels above 100 and below 0', () => {
    const over = decodeSvg(generateFaderSvg(150, false, '#fff'));
    const under = decodeSvg(generateFaderSvg(-20, false, '#fff'));
    expect(over).toContain('<circle cx="12" cy="12" r="7" fill="#fff" stroke-width="0" />');
    expect(under).not.toContain('<path d="M 12 12');
  });

  it('uses the large-arc-flag once the slice passes 180 degrees', () => {
    const svg = decodeSvg(generateFaderSvg(75, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 1 1/);
  });

  it('does not use the large-arc-flag below 180 degrees', () => {
    const svg = decodeSvg(generateFaderSvg(25, false, '#fff'));
    expect(svg).toMatch(/A 7 7 0 0 1/);
  });

  it('always draws the outer ring', () => {
    const svg = decodeSvg(generateFaderSvg(42, false, '#abc'));
    expect(svg).toContain('<circle cx="12" cy="12" r="9" stroke="#abc" stroke-width="1.5" fill="none"/>');
  });
});
