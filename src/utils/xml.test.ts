import { describe, it, expect } from 'vitest';
import { escapeXml, decodeXmlEntities } from './xml';

describe('escapeXml', () => {
  it('escapes all five standard entities', () => {
    expect(escapeXml(`<a href="x">Tom & Jerry's</a>`))
      .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeXml('AC/DC – Back in Black')).toBe('AC/DC – Back in Black');
  });
});

describe('decodeXmlEntities', () => {
  it('decodes all five standard entities', () => {
    expect(decodeXmlEntities('&lt;b&gt; &quot;Rock &amp; Roll&quot; &apos;live&apos;'))
      .toBe(`<b> "Rock & Roll" 'live'`);
  });

  it('round-trips with escapeXml', () => {
    const original = `x-file-cifs://NAS/Musik/Tom & Jerry's <Best> "Hits".mp3`;
    expect(decodeXmlEntities(escapeXml(original))).toBe(original);
  });

  it('decodes &amp; last so double-encoded entities survive', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });
});
