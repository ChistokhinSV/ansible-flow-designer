// The theme outside VS Code (AFD-269). In a webview VS Code sets a class on <body> and its
// --vscode-* variables; a web page has neither, so mount() and the harness set these. The values
// approximate VS Code's default themes; variables not listed fall back in the stylesheets.
import type { ThemeKind } from '../../core/theme';

/** The class VS Code puts on <body> for each kind of theme (read by `themeKindOf`). */
export const THEME_CLASS: Record<ThemeKind, string> = {
  light: 'vscode-light',
  dark: 'vscode-dark',
  'hc-dark': 'vscode-high-contrast',
  'hc-light': 'vscode-high-contrast-light',
};

export const STANDALONE_THEMES: Record<ThemeKind, Record<string, string>> = {
  light: {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#3b3b3b',
    '--vscode-sideBar-background': '#f8f8f8',
    '--vscode-panel-border': '#e5e5e5',
    '--vscode-descriptionForeground': '#717171',
    '--vscode-focusBorder': '#005fb8',
    '--vscode-button-background': '#005fb8',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-border': '#cecece',
  },
  dark: {
    '--vscode-editor-background': '#1f1f1f',
    '--vscode-editor-foreground': '#cccccc',
    '--vscode-sideBar-background': '#181818',
    '--vscode-panel-border': '#2b2b2b',
    '--vscode-descriptionForeground': '#9d9d9d',
    '--vscode-focusBorder': '#0078d4',
    '--vscode-button-background': '#0078d4',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-input-background': '#313131',
    '--vscode-input-border': '#3c3c3c',
    '--vscode-editorLineNumber-foreground': '#4a4a4a',
  },
  'hc-dark': {
    '--vscode-editor-background': '#000000',
    '--vscode-editor-foreground': '#ffffff',
    '--vscode-sideBar-background': '#000000',
    '--vscode-panel-border': '#6fc3df',
    '--vscode-descriptionForeground': '#ffffff',
    '--vscode-focusBorder': '#f38518',
    '--vscode-button-background': '#000000',
    '--vscode-button-border': '#6fc3df',
    '--vscode-contrastBorder': '#6fc3df',
    '--vscode-input-background': '#000000',
    '--vscode-input-border': '#6fc3df',
  },
  'hc-light': {
    '--vscode-editor-background': '#ffffff',
    '--vscode-editor-foreground': '#292929',
    '--vscode-sideBar-background': '#ffffff',
    '--vscode-panel-border': '#0f4a85',
    '--vscode-descriptionForeground': '#292929',
    '--vscode-focusBorder': '#006bbd',
    '--vscode-button-background': '#0f4a85',
    '--vscode-button-foreground': '#ffffff',
    '--vscode-button-border': '#0f4a85',
    '--vscode-contrastBorder': '#0f4a85',
    '--vscode-input-background': '#ffffff',
    '--vscode-input-border': '#0f4a85',
  },
};

/**
 * AFD-383: colours a host page gives the canvas, so the canvas matches the page around it instead
 * of VS Code's defaults: values for the `--vscode-*` variables the canvas reads, laid over the
 * standalone theme's.
 */
export type Palette = Readonly<Record<string, string>>;

const PALETTE_NAME = /^--vscode-[A-Za-z0-9-]+$/;
// Colours only: a palette is not a way to change the canvas's fonts or to load a url().
const COLOUR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?)\([0-9.,%\s/+-]+\)|transparent)$/;

/** The entries of a palette the canvas takes: `--vscode-*` names with colour values. */
export function paletteEntries(palette: Palette | undefined): [string, string][] {
  const taken: [string, string][] = [];
  for (const [name, value] of Object.entries(palette ?? {}))
    if (typeof value === 'string' && PALETTE_NAME.test(name) && COLOUR.test(value.trim()))
      taken.push([name, value.trim()]);
  return taken;
}

/** The palette names set on each page, so the next palette (or none) can take them back. */
const fromPalette = new WeakMap<Document, string[]>();

/**
 * Makes the page look like a webview of this theme kind: the class on <body> (the designer's own
 * tokens follow it, App.tsx) and the variables on <html>. Variables of the other kinds are removed.
 * A host's palette is laid over them, except in the high contrast kinds: those exist for people
 * who need that contrast, and a page's own colours would take it away.
 */
export function applyStandaloneTheme(doc: Document, kind: ThemeKind, palette?: Palette): void {
  const vars = STANDALONE_THEMES[kind];
  const style = doc.documentElement.style;
  for (const cls of Object.values(THEME_CLASS)) doc.body.classList.remove(cls);
  doc.body.classList.add(THEME_CLASS[kind]);
  for (const k of fromPalette.get(doc) ?? []) if (!(k in vars)) style.removeProperty(k);
  for (const [k, v] of Object.entries(vars)) style.setProperty(k, v);
  for (const other of Object.values(STANDALONE_THEMES))
    for (const k of Object.keys(other)) if (!(k in vars)) style.removeProperty(k);
  const taken = kind === 'light' || kind === 'dark' ? paletteEntries(palette) : [];
  for (const [k, v] of taken) style.setProperty(k, v);
  fromPalette.set(
    doc,
    taken.map(([k]) => k),
  );
}
