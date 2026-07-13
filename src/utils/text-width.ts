// True per-glyph advance widths for Arial, in 1/1000 em (Arial is metrically identical to
// Helvetica; values from the standard Helvetica AFM). The dials' SVG feedback is rasterized by
// the Stream Deck software using the SYSTEM Arial font, so summing real advance widths matches
// what actually ends up on the display — unlike the old `chars × 0.55-0.58 × fontSize` heuristic,
// whose per-character overshoot grew linearly with text length. On the panorama dial's
// right-aligned track text that showed as a background pill jutting further and further out to
// the LEFT of long titles (worst once the text spilled onto the neighboring display).
//
// Note on font-weight 500: Arial ships no medium face — renderers snap 500 to regular, so the
// regular metrics below apply to the "500" title text too.

const ARIAL_WIDTHS: Record<string, number> = {
    ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
    '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
    '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
    '8': 556, '9': 556,
    ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
    'A': 667, 'B': 667, 'C': 722, 'D': 722, 'E': 667, 'F': 611, 'G': 778, 'H': 722,
    'I': 278, 'J': 500, 'K': 667, 'L': 556, 'M': 833, 'N': 722, 'O': 778, 'P': 667,
    'Q': 778, 'R': 722, 'S': 667, 'T': 611, 'U': 722, 'V': 667, 'W': 944, 'X': 667,
    'Y': 667, 'Z': 611,
    '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
    'a': 556, 'b': 556, 'c': 500, 'd': 556, 'e': 556, 'f': 278, 'g': 556, 'h': 556,
    'i': 222, 'j': 222, 'k': 500, 'l': 222, 'm': 833, 'n': 556, 'o': 556, 'p': 556,
    'q': 556, 'r': 333, 's': 500, 't': 278, 'u': 556, 'v': 500, 'w': 722, 'x': 500,
    'y': 500, 'z': 500,
    '{': 334, '|': 260, '}': 334, '~': 584,
    // Common non-ASCII in track/artist names that NFD cannot reduce to a base letter.
    'ß': 611, '€': 556, '–': 556, '—': 1000, '…': 1000, '°': 400, '·': 278,
    '‘': 222, '’': 222, '“': 333, '”': 333, '„': 333,
};

// Typical lowercase/digit advance — fallback for glyphs not covered above.
const DEFAULT_WIDTH = 556;

/**
 * Width of `text` rendered in Arial at `fontSize`, in pixels. Accented characters fall back to
 * their base letter's advance (ä→a, é→e, …) via NFD decomposition, which is exact for Arial —
 * diacritics don't change the advance width.
 */
export function measureArialWidth(text: string, fontSize: number): number {
    let units = 0;
    for (const ch of text) {
        units += ARIAL_WIDTHS[ch] ?? ARIAL_WIDTHS[stripDiacritics(ch)] ?? DEFAULT_WIDTH;
    }
    return Math.ceil((units / 1000) * fontSize);
}

function stripDiacritics(ch: string): string {
    return ch.normalize('NFD')[0] ?? ch;
}
