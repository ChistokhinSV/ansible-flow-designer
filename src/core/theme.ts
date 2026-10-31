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
