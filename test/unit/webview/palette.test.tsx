// AFD-383: a host page gives the canvas its own colours, so the canvas matches the page instead
// of VS Code's defaults.
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '../../../src/webview/mount';
import {
  applyStandaloneTheme,
  paletteEntries,
  STANDALONE_THEMES,
} from '../../../src/webview/theme/standalone';
import type { DesignerTransport } from '../../../src/webview/transport';

const transport: DesignerTransport = {
  post: () => undefined,
  subscribe: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

const value = (name: string) => document.documentElement.style.getPropertyValue(name);

/** The colours of a navy and teal page. */
const navy = {
  '--vscode-editor-background': '#12171e',
  '--vscode-sideBar-background': '#0f141a',
  '--vscode-button-background': '#3ccfb8',
  '--vscode-focusBorder': 'rgb(60, 207, 184)',
};

afterEach(() => {
  cleanup();
  document.body.className = '';
  document.documentElement.removeAttribute('style');
});

async function mounted(options: Partial<Parameters<typeof mount>[1]>) {
  const el = document.createElement('div');
  document.body.append(el);
  let designer: ReturnType<typeof mount> | undefined;
  await act(async () => {
    designer = mount(el, { transport, theme: 'dark', ...options });
  });
  return designer as ReturnType<typeof mount>;
}

describe('AFD-383: the host page colours the canvas', () => {
  it('lays the palette over the theme, and setPalette takes it back', async () => {
    const designer = await mounted({ palette: navy });
    expect(value('--vscode-editor-background')).toBe('#12171e');
    expect(value('--vscode-button-background')).toBe('#3ccfb8');
    // A name the theme does not set is set by the palette alone.
    expect(value('--vscode-focusBorder')).toBe('rgb(60, 207, 184)');
    // What the palette leaves out keeps the theme's colour.
    expect(value('--vscode-panel-border')).toBe(STANDALONE_THEMES.dark['--vscode-panel-border']);

    designer.setPalette({ '--vscode-editor-background': '#0b0f14' });
    expect(value('--vscode-editor-background')).toBe('#0b0f14');
    expect(value('--vscode-button-background')).toBe(
      STANDALONE_THEMES.dark['--vscode-button-background'],
    );

    designer.setPalette(undefined);
    expect(value('--vscode-editor-background')).toBe(
      STANDALONE_THEMES.dark['--vscode-editor-background'],
    );
    await act(async () => designer.unmount());
  });

  it('keeps the palette across a change of theme, and leaves high contrast alone', async () => {
    const designer = await mounted({ palette: navy });
    designer.setTheme('light');
    expect(value('--vscode-editor-background')).toBe('#12171e');

    // High contrast is for people who need it: the page's colours would take it away.
    designer.setTheme('hc-dark');
    expect(value('--vscode-editor-background')).toBe(
      STANDALONE_THEMES['hc-dark']['--vscode-editor-background'],
    );
    expect(value('--vscode-sideBar-background')).toBe(
      STANDALONE_THEMES['hc-dark']['--vscode-sideBar-background'],
    );

    designer.setTheme('dark');
    expect(value('--vscode-editor-background')).toBe('#12171e');
    await act(async () => designer.unmount());
  });

  it('takes only colours for the canvas variables', () => {
    expect(
      paletteEntries({
        '--vscode-editor-background': ' #12171e ',
        '--vscode-textLink-foreground': 'hsl(170 60% 55%)',
        '--vscode-widget-shadow': 'rgba(0, 0, 0, 0.45)',
        // Not the canvas's variables.
        '--page-accent': '#3ccfb8',
        color: '#ffffff',
        // Not colours.
        '--vscode-editor-font-family': 'Comic Sans MS',
        '--vscode-editorWidget-background': 'url(https://example.com/x.png)',
        '--vscode-menu-background': 'red; background: blue',
      }),
    ).toEqual([
      ['--vscode-editor-background', '#12171e'],
      ['--vscode-textLink-foreground', 'hsl(170 60% 55%)'],
      ['--vscode-widget-shadow', 'rgba(0, 0, 0, 0.45)'],
    ]);
  });

  it('without a palette the page has exactly the theme it had before', () => {
    applyStandaloneTheme(document, 'dark');
    const before = document.documentElement.getAttribute('style');
    applyStandaloneTheme(document, 'dark', navy);
    applyStandaloneTheme(document, 'dark');
    expect(document.documentElement.getAttribute('style')).toBe(before);
  });
});
