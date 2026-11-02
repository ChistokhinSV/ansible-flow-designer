// Port, status and fill colours of the 04 visual language per theme kind. The webview applies them as
// CSS custom properties (webview/theme/tokens.ts); the exports draw with the light ones (AFD-25).

export type ThemeKind = 'light' | 'dark' | 'hc-dark' | 'hc-light';

export type ToneToken =
  | 'ok'
  | 'failed'
  | 'unreachable'
  | 'decision'
  | 'approval'
  | 'undo'
  | 'neutral'
  | 'accent';

export type FillToken =
  | 'fill-specified'
  | 'fill-implemented'
  | 'fill-tested'
  | 'fill-decision'
  | 'fill-approval'
  | 'fill-handler'
  | 'fill-failed-end';

export const TONES: Record<ThemeKind, Record<ToneToken, string>> = {
  light: {
    ok: '#2f855a',
    failed: '#c2410c',
    unreachable: '#b45309',
    decision: '#3b62c4',
    approval: '#6b5bd2',
    undo: '#0f766e',
    neutral: '#6b7280',
    accent: '#1d4ed8',
  },
  dark: {
    ok: '#4fbf83',
    failed: '#f07a4a',
    unreachable: '#f0a742',
    decision: '#7f9cf5',
    approval: '#a99cf0',
    undo: '#3cc2b4',
    neutral: '#9aa0a6',
    accent: '#5b8def',
  },
  'hc-dark': {
    ok: '#57e389',
    failed: '#ff8c5a',
    unreachable: '#ffc457',
    decision: '#9db4ff',
    approval: '#c4b8ff',
    undo: '#4ee0d0',
    neutral: '#c8c8c8',
    accent: '#f38518',
  },
  'hc-light': {
    ok: '#1b6b44',
    failed: '#a3330a',
    unreachable: '#8a4b00',
    decision: '#2349a8',
    approval: '#4f3fb0',
    undo: '#0b5c56',
    neutral: '#4b5058',
    accent: '#0f4a85',
  },
};

export const FILLS: Record<ThemeKind, Record<FillToken, string>> = {
  light: {
    'fill-specified': '#f3f0ff',
    'fill-implemented': '#e9f7f1',
    'fill-tested': '#dcf2e6',
    'fill-decision': '#eaf1fb',
    'fill-approval': '#f1effc',
    'fill-handler': '#fdf2e7',
    'fill-failed-end': '#fdecec',
  },
  dark: {
    'fill-specified': '#2c2645',
    'fill-implemented': '#1c3329',
    'fill-tested': '#1a3d2c',
    'fill-decision': '#1e2a40',
    'fill-approval': '#2a2542',
    'fill-handler': '#3a2a17',
    'fill-failed-end': '#3d1f1f',
  },
  // High contrast: no tinted fills; borders and shapes carry the meaning.
  'hc-dark': {
    'fill-specified': 'transparent',
    'fill-implemented': 'transparent',
    'fill-tested': 'transparent',
    'fill-decision': 'transparent',
    'fill-approval': 'transparent',
    'fill-handler': 'transparent',
    'fill-failed-end': 'transparent',
  },
  'hc-light': {
    'fill-specified': 'transparent',
    'fill-implemented': 'transparent',
    'fill-tested': 'transparent',
    'fill-decision': 'transparent',
    'fill-approval': 'transparent',
    'fill-handler': 'transparent',
    'fill-failed-end': 'transparent',
  },
};

/**
 * Annotation colours (AFD-65): a Note's fill, and the ink of a Section's border and title and of
 * Text. High contrast keeps no fills; the ink carries the colour where the theme allows one.
 */
export type AnnotationTone = 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'gray';

export const NOTE_COLORS: Record<
  ThemeKind,
  Record<AnnotationTone, { fill: string; ink: string }>
> = {
  light: {
    yellow: { fill: '#fff4c2', ink: '#7a5600' },
    blue: { fill: '#e2edff', ink: '#1f4e9e' },
    green: { fill: '#e0f5e7', ink: '#1d6336' },
    pink: { fill: '#fde6ef', ink: '#9b2358' },
    purple: { fill: '#eee7ff', ink: '#5536b0' },
    gray: { fill: '#eceef1', ink: '#4b5058' },
  },
  dark: {
    yellow: { fill: '#4a3e10', ink: '#f2d46b' },
    blue: { fill: '#1c2d4a', ink: '#8ab4ff' },
    green: { fill: '#1a3925', ink: '#7ed49a' },
    pink: { fill: '#45202f', ink: '#f59ac0' },
    purple: { fill: '#2f2550', ink: '#c1aaff' },
    gray: { fill: '#2e3137', ink: '#c3c7cd' },
  },
  'hc-dark': {
    yellow: { fill: 'transparent', ink: '#ffff00' },
    blue: { fill: 'transparent', ink: '#8ab4ff' },
    green: { fill: 'transparent', ink: '#89d185' },
    pink: { fill: 'transparent', ink: '#ff9ccf' },
    purple: { fill: 'transparent', ink: '#d0b8ff' },
    gray: { fill: 'transparent', ink: '#ffffff' },
  },
  'hc-light': {
    yellow: { fill: 'transparent', ink: '#5c4400' },
    blue: { fill: 'transparent', ink: '#0f3d8a' },
    green: { fill: 'transparent', ink: '#0f5223' },
    pink: { fill: 'transparent', ink: '#8a1846' },
    purple: { fill: 'transparent', ink: '#45249c' },
    gray: { fill: 'transparent', ink: '#292929' },
  },
};
