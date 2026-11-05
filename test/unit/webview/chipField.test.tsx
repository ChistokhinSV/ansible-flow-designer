// AFD-79: Ctrl+V into a parameter value. VS Code pastes into a webview by running
// execCommand('paste') in it, and Chromium refuses an execCommand from inside that paste, so the
// field must insert the text itself. Here execCommand refuses, as it does in VS Code.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChipField } from '../../../src/webview/properties/ChipField';

const refuse = vi.fn(() => false);
let saved: Document['execCommand'] | undefined;

beforeEach(() => {
  saved = document.execCommand;
  document.execCommand = refuse;
});

afterEach(() => {
  cleanup();
  if (saved) document.execCommand = saved;
  refuse.mockClear();
});

function field(value: string) {
  const onChange = vi.fn();
  render(
    <ChipField
      id="p"
      label="path"
      value={value}
      onChange={onChange}
      choices={[]}
      onAddInput={() => {}}
    />,
  );
  return { el: screen.getByRole('textbox', { name: 'path' }), onChange };
}

function select(start: Node, from: number, end: Node, to: number) {
  const r = document.createRange();
  r.setStart(start, from);
  r.setEnd(end, to);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

const paste = (el: HTMLElement, text: string) =>
  fireEvent.paste(el, {
    clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : '') },
  });

describe('ChipField paste (AFD-79)', () => {
  it('Ctrl+V into an empty field sets the value', () => {
    const { el, onChange } = field('');
    el.focus();
    select(el, 0, el, 0);
    paste(el, '/etc/issue.net');
    expect(onChange).toHaveBeenLastCalledWith('/etc/issue.net');
    expect(refuse).not.toHaveBeenCalled();
  });

  it('replaces the selected text and keeps the rest', () => {
    const { el, onChange } = field('abc');
    const text = el.firstChild as Text;
    select(text, 1, text, 2);
    paste(el, 'XYZ');
    expect(onChange).toHaveBeenLastCalledWith('aXYZc');
  });

  it('keeps an input chip and pastes after it as one line', () => {
    const { el, onChange } = field('copy {{ image }}');
    select(el, el.childNodes.length, el, el.childNodes.length);
    paste(el, ' to\r\nflash');
    const value = onChange.mock.lastCall?.[0] as string;
    expect(value).toMatch(/^copy \{\{ ?image ?\}\} to ?flash$/);
  });
});

// Round 3 (R5, AFD-102): the @ button put the chip at the end of the value, even when the
// participant had selected the text the input should replace.
describe('ChipField @ button (AFD-102)', () => {
  const server = { name: 'archive_server', label: 'flow.archive_server', detail: 'flow input' };

  function withChoice(value: string) {
    const onChange = vi.fn();
    render(
      <ChipField
        id="u"
        label="url"
        value={value}
        onChange={onChange}
        choices={[server]}
        onAddInput={() => {}}
      />,
    );
    const el = screen.getByRole('textbox', { name: 'url' });
    const pickVia = () => {
      const at = screen.getByRole('button', { name: 'Insert an input into url' });
      fireEvent.mouseDown(at);
      fireEvent.click(at);
      fireEvent.mouseDown(screen.getByRole('option'));
    };
    return { el, onChange, pickVia };
  }

  it('replaces the selected text', () => {
    const url = 'https://archive-01.lab.example/upload';
    const { el, onChange, pickVia } = withChoice(url);
    const text = el.firstChild as Text;
    const from = url.indexOf('archive-01');
    select(text, from, text, from + 'archive-01.lab.example'.length);
    pickVia();
    expect(onChange).toHaveBeenLastCalledWith('https://{{ archive_server }}/upload');
  });

  it('inserts at the caret', () => {
    const { el, onChange, pickVia } = withChoice('https:///upload');
    select(el.firstChild as Text, 8, el.firstChild as Text, 8);
    pickVia();
    expect(onChange).toHaveBeenLastCalledWith('https://{{ archive_server }}/upload');
  });

  it('adds at the end when the caret is not in the field', () => {
    const { onChange, pickVia } = withChoice('host ');
    window.getSelection()?.removeAllRanges();
    pickVia();
    expect(onChange).toHaveBeenLastCalledWith('host {{ archive_server }}');
  });
});
