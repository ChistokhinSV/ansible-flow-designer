// AFD-269: the designer reaches its host through a transport, so a web page can host it.
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostMessage, WebviewMessage } from '../../../src/core/protocol';
import { command, onHostMessage, REQUEST_TIMEOUT_MS, setTransport } from '../../../src/webview/bus';
import { mount } from '../../../src/webview/mount';
import { THEME_CLASS } from '../../../src/webview/theme/standalone';
import type { DesignerTransport } from '../../../src/webview/transport';

/** A host in the page: what the designer posted, and a way to answer it. */
function fakeHost(hostName?: string) {
  const posted: WebviewMessage[] = [];
  const listeners = new Set<(m: HostMessage) => void>();
  let state: unknown;
  const transport: DesignerTransport = {
    hostName,
    post: (m) => posted.push(m),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    setState: (s) => {
      state = s;
    },
  };
  return {
    transport,
    posted,
    listeners,
    say: (m: HostMessage) => {
      for (const l of listeners) l(m);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.className = '';
});

describe('AFD-269: a transport other than VS Code', () => {
  it('carries a command to the host and its answer back', async () => {
    const host = fakeHost();
    setTransport(host.transport);
    const answer = command({ kind: 'deleteNodes', ids: [] } as never);
    const sent = host.posted.at(-1) as { type: string; reqId: number };
    expect(sent.type).toBe('command');
    host.say({ type: 'ack', reqId: sent.reqId, ok: true });
    await expect(answer).resolves.toMatchObject({ ok: true });
  });

  it('hands host messages to the listeners, and stops listening to the transport it replaced', () => {
    const first = fakeHost();
    const second = fakeHost();
    const seen: string[] = [];
    const off = onHostMessage((m) => seen.push(m.type));
    setTransport(first.transport);
    setTransport(second.transport);
    expect(first.listeners.size).toBe(0);
    second.say({ type: 'setMode', mode: 'run' } as HostMessage);
    expect(seen).toEqual(['setMode']);
    off();
  });

  it('names the host when a request goes unanswered', async () => {
    vi.useFakeTimers();
    setTransport(fakeHost('The server').transport);
    const answer = command({ kind: 'deleteNodes', ids: [] } as never);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(answer).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The server did not answer/),
    });
  });
});

describe('AFD-269: mount() shows the designer in a page', () => {
  it('sets the theme, says ready to the host, and unmounts', async () => {
    const host = fakeHost();
    const el = document.createElement('div');
    document.body.append(el);
    let mounted: ReturnType<typeof mount> | undefined;
    await act(async () => {
      mounted = mount(el, { transport: host.transport, theme: 'dark' });
    });
    expect(document.body.classList.contains(THEME_CLASS.dark)).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--vscode-editor-background')).toBe(
      '#1f1f1f',
    );
    expect(host.posted.some((m) => m.type === 'ready')).toBe(true);
    expect(el.childElementCount).toBeGreaterThan(0);

    mounted?.setTheme('hc-light');
    expect(document.body.classList.contains(THEME_CLASS['hc-light'])).toBe(true);
    expect(document.body.classList.contains(THEME_CLASS.dark)).toBe(false);
    // A variable only the dark theme sets is gone.
    expect(
      document.documentElement.style.getPropertyValue('--vscode-editorLineNumber-foreground'),
    ).toBe('');

    await act(async () => mounted?.unmount());
    expect(el.childElementCount).toBe(0);
    el.remove();
  });
});
