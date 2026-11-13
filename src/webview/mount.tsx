// The designer in a web page (ADR-0036, AFD-269): the entry of @ansible-flow/designer. main.tsx is
// the entry inside VS Code.
import '@xyflow/react/dist/style.css';
import '@vscode/codicons/dist/codicon.css';
import './styles/index.css';
import { createRoot } from 'react-dom/client';
import type { ThemeKind } from '../core/theme';
import { App } from './App';
import { setTransport } from './bus';
import { applyStandaloneTheme } from './theme/standalone';
import type { DesignerTransport } from './transport';

export type { ThemeKind } from '../core/theme';
export type { DesignerTransport } from './transport';

/** A theme kind, or `auto`: light or dark as the browser prefers, and it follows a change. */
export type ThemeChoice = ThemeKind | 'auto';

export interface MountOptions {
  /** How the designer talks to its host. */
  transport: DesignerTransport;
  /** Default `auto`. */
  theme?: ThemeChoice;
}

export interface MountedDesigner {
  setTheme(theme: ThemeChoice): void;
  /** Removes the designer from the element. The page's theme class and variables stay. */
  unmount(): void;
}

/**
 * Shows the designer in `el`. The designer is made to be the whole page, as it is in a VS Code
 * webview: its stylesheet styles <body>, its keys are handled on the window and its menus open on
 * <body>. Give it a page or an iframe of its own; `el` fills its parent.
 */
export function mount(el: HTMLElement, options: MountOptions): MountedDesigner {
  setTransport(options.transport);
  const doc = el.ownerDocument;
  const dark = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  let choice: ThemeChoice = options.theme ?? 'auto';
  const apply = () =>
    applyStandaloneTheme(doc, choice === 'auto' ? (dark?.matches ? 'dark' : 'light') : choice);
  apply();
  dark?.addEventListener('change', apply);
  el.style.height = '100%';
  const root = createRoot(el);
  root.render(<App />);
  return {
    setTheme(theme) {
      choice = theme;
      apply();
    },
    unmount() {
      dark?.removeEventListener('change', apply);
      root.unmount();
    },
  };
}
