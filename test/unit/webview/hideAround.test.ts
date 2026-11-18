// AFD-334 (AFS-156): a modal dialog hides the page around it from readers, keeps the toasts, and
// gives everything back when it closes.
import { describe, expect, it } from 'vitest';
import { hideAround } from '../../../src/webview/focus';

describe('hideAround (AFD-334)', () => {
  it('makes the rest inert, keeps the live region, and undoes only what it did', () => {
    document.body.innerHTML = `
      <div id="app">
        <header id="top"></header>
        <span id="mark" aria-hidden="true"></span>
        <main id="main"><div id="canvas"></div><div id="toasts" aria-live="polite"></div></main>
        <div id="backdrop"><div id="dialog" role="dialog"></div></div>
      </div>`;
    const $ = (id: string) => document.getElementById(id) as HTMLElement;
    const undo = hideAround($('dialog'));
    expect($('top').hasAttribute('inert')).toBe(true);
    expect($('top').getAttribute('aria-hidden')).toBe('true');
    expect($('canvas').hasAttribute('inert')).toBe(true);
    expect($('main').hasAttribute('inert')).toBe(false);
    expect($('toasts').hasAttribute('inert')).toBe(false);
    expect($('backdrop').hasAttribute('inert')).toBe(false);
    undo?.();
    expect(document.querySelectorAll('[inert]')).toHaveLength(0);
    expect($('top').hasAttribute('aria-hidden')).toBe(false);
    // Hidden before the dialog: stays hidden.
    expect($('mark').getAttribute('aria-hidden')).toBe('true');
    document.body.innerHTML = '';
  });
});
