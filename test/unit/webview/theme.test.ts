import { describe, expect, it } from 'vitest';
import {
  contrast,
  FILLS,
  INPUT_BACKGROUNDS,
  LENS_CHIPS,
  NOTE_COLORS,
  REFERENCE_BACKGROUNDS,
  SYNTAX,
  type ThemeKind,
  TONES,
} from '../../../src/webview/theme/tokens';

const KINDS = Object.keys(TONES) as ThemeKind[];
/** Default editor foregrounds, for text on tinted node fills. */
const FOREGROUND: Record<ThemeKind, string> = {
  light: '#3b3b3b',
  dark: '#cccccc',
  'hc-dark': '#ffffff',
  'hc-light': '#292929',
};

describe('theme tokens (08: check the 04 palette on dark and high-contrast)', () => {
  it.each(KINDS)('%s: port and wire colors reach 3:1 against the editor background', (kind) => {
    for (const [token, color] of Object.entries(TONES[kind])) {
      expect(
        contrast(color, REFERENCE_BACKGROUNDS[kind]),
        `${kind} ${token}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(KINDS)('%s: node text stays readable (4.5:1) on every tinted fill', (kind) => {
    for (const [token, fill] of Object.entries(FILLS[kind])) {
      const bg = fill === 'transparent' ? REFERENCE_BACKGROUNDS[kind] : fill;
      expect(contrast(FOREGROUND[kind], bg), `${kind} ${token}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(KINDS)('%s: lens chip text (4.5:1) on its chip, data wires (3:1)', (kind) => {
    for (const [lens, { bg, fg }] of Object.entries(LENS_CHIPS[kind])) {
      const under = bg === 'transparent' ? REFERENCE_BACKGROUNDS[kind] : bg;
      expect(contrast(fg, under), `${kind} ${lens}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(LENS_CHIPS[kind].data.fg, REFERENCE_BACKGROUNDS[kind])).toBeGreaterThanOrEqual(
      3,
    );
  });

  it.each(KINDS)(
    '%s: note text (4.5:1) on every note fill; section and text ink (4.5:1) on the canvas',
    (kind) => {
      for (const [color, { fill, ink }] of Object.entries(NOTE_COLORS[kind])) {
        const bg = fill === 'transparent' ? REFERENCE_BACKGROUNDS[kind] : fill;
        expect(contrast(FOREGROUND[kind], bg), `${kind} ${color} fill`).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(ink, REFERENCE_BACKGROUNDS[kind]),
          `${kind} ${color} ink`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(KINDS)('%s: Jinja and YAML syntax colours (4.5:1) on the input background', (kind) => {
    for (const [token, color] of Object.entries(SYNTAX[kind]))
      expect(contrast(color, INPUT_BACKGROUNDS[kind]), `${kind} ${token}`).toBeGreaterThanOrEqual(
        4.5,
      );
  });

  it('contrast() matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});
