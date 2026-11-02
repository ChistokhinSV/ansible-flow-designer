// Color tokens of the 04 visual language with dark and high-contrast variants. One source of truth:
// applied as CSS custom properties at runtime (CSSOM, allowed by the CSP) and checked for contrast
// in unit tests. Everything else (backgrounds, text, focus) comes from VS Code's --vscode-* vars.

import { FILLS, NOTE_COLORS, type ThemeKind, TONES } from '../../core/theme';

// The palette lives in core (AFD-25: the exports use it too).
export {
  FILLS,
  type FillToken,
  NOTE_COLORS,
  type ThemeKind,
  TONES,
  type ToneToken,
} from '../../core/theme';

export type LensToken = 'inventory' | 'data' | 'code' | 'access' | 'timing' | 'changes';

/** Lens chip colors (04 §9); high contrast drops the tint and keeps a strong text color. */
export const LENS_CHIPS: Record<ThemeKind, Record<LensToken, { bg: string; fg: string }>> = {
  light: {
    inventory: { bg: '#e8f1fb', fg: '#1e4f86' },
    data: { bg: '#f3f0ff', fg: '#4c3fa8' },
    code: { bg: '#e9f7f1', fg: '#0f5a43' },
    access: { bg: '#fdf2e7', fg: '#8a4b0a' },
    timing: { bg: '#f1f2f4', fg: '#3d444d' },
    changes: { bg: '#e7f3f8', fg: '#0b4f6c' },
  },
  dark: {
    inventory: { bg: '#1b2c42', fg: '#9cc3f0' },
    data: { bg: '#2c2645', fg: '#c3b8ff' },
    code: { bg: '#1c3329', fg: '#8fdcb7' },
    access: { bg: '#3a2a17', fg: '#f2c48a' },
    timing: { bg: '#2b2e33', fg: '#c9ced6' },
    changes: { bg: '#173240', fg: '#9fd3ea' },
  },
  'hc-dark': {
    inventory: { bg: 'transparent', fg: '#9db4ff' },
    data: { bg: 'transparent', fg: '#c4b8ff' },
    code: { bg: 'transparent', fg: '#57e389' },
    access: { bg: 'transparent', fg: '#ffc457' },
    timing: { bg: 'transparent', fg: '#ffffff' },
    changes: { bg: 'transparent', fg: '#7fdbff' },
  },
  'hc-light': {
    inventory: { bg: 'transparent', fg: '#0f4a85' },
    data: { bg: 'transparent', fg: '#4f3fb0' },
    code: { bg: 'transparent', fg: '#1b6b44' },
    access: { bg: 'transparent', fg: '#8a4b00' },
    timing: { bg: 'transparent', fg: '#292929' },
    changes: { bg: 'transparent', fg: '#004b6b' },
  },
};

/** Representative editor backgrounds of the default themes, for contrast checks. */
export const REFERENCE_BACKGROUNDS: Record<ThemeKind, string> = {
  light: '#ffffff',
  dark: '#1f1f1f',
  'hc-dark': '#000000',
  'hc-light': '#ffffff',
};

export function themeKindOf(body: { classList: { contains(c: string): boolean } }): ThemeKind {
  if (body.classList.contains('vscode-high-contrast-light')) return 'hc-light';
  if (body.classList.contains('vscode-high-contrast')) return 'hc-dark';
  if (body.classList.contains('vscode-dark')) return 'dark';
  return 'light';
}

export function applyTheme(root: HTMLElement, kind: ThemeKind): void {
  for (const [k, v] of Object.entries(TONES[kind])) root.style.setProperty(`--afd-${k}`, v);
  for (const [k, v] of Object.entries(FILLS[kind])) root.style.setProperty(`--afd-${k}`, v);
  for (const [k, v] of Object.entries(LENS_CHIPS[kind])) {
    root.style.setProperty(`--afd-lens-${k}-bg`, v.bg);
    root.style.setProperty(`--afd-lens-${k}-fg`, v.fg);
  }
  for (const [k, v] of Object.entries(NOTE_COLORS[kind])) {
    root.style.setProperty(`--afd-note-${k}`, v.fill);
    root.style.setProperty(`--afd-note-${k}-ink`, v.ink);
  }
  // Data lens wires take the data chip's text color.
  root.style.setProperty('--afd-lens-data', LENS_CHIPS[kind].data.fg);
  root.dataset.theme = kind;
}

/** WCAG relative luminance contrast ratio of two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (bl ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
