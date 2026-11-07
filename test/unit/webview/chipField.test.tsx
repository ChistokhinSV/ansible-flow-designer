// AFD-79: Ctrl+V into a parameter value. VS Code pastes into a webview by running
// execCommand('paste') in it, and Chromium refuses an execCommand from inside that paste, so the
// field must insert the text itself. Here execCommand refuses, as it does in VS Code.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefChoice } from '../../../src/core/catalog/draft';
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

// Wave 10 Z1 (AFD-108): the @ list offered a step's whole result; `.stdout` typed after its chip
// stayed text outside the braces. A result's fields are offered three ways.
describe('ChipField: a field of a result (AFD-108)', () => {
  const fields = [
    { name: 'stdout', detail: 'The set of responses from the commands.' },
    { name: 'stdout_lines', detail: 'The value of stdout split into a list.' },
    { name: 'failed_conditions', detail: 'The list of conditionals that have failed.' },
  ];
  const result: RefChoice = {
    name: 'read_version_result',
    label: 'read-version.read_version_result',
    detail: 'result of "Read the software version" · makes it an output there',
    field: { type: 'dict', from: 'read-version.read_version_result' },
    expose: { node: '01JTESTREADVERSION0000000000', output: 'read_version_result' },
    fields,
  };
  const input: RefChoice = {
    name: 'read_version_result',
    label: 'read_version_result',
    detail: 'input from read-version.read_version_result',
    fields,
  };
  const host: RefChoice = { name: 'hostname', label: 'hostname', detail: 'node input' };

  function withChoices(value: string, choices: RefChoice[]) {
    const onChange = vi.fn();
    const onAddInput = vi.fn();
    render(
      <ChipField
        id="c"
        label="commands"
        value={value}
        onChange={onChange}
        choices={choices}
        onAddInput={onAddInput}
      />,
    );
    return { el: screen.getByRole('textbox', { name: 'commands' }), onChange, onAddInput };
  }

  /** Types `text` into the text node after the last chip, as the browser does, caret at its end. */
  function typeAfterChip(el: HTMLElement, text: string) {
    let node = el.lastChild;
    if (!(node instanceof Text)) {
      node = document.createTextNode('');
      el.append(node);
    }
    node.textContent = text;
    select(node, text.length, node, text.length);
    fireEvent.input(el);
  }

  it('picking a result offers its fields next, and a field goes into the chip', () => {
    const { el, onChange, onAddInput } = withChoices('show ', [result]);
    select(el.firstChild as Text, 5, el.firstChild as Text, 5);
    const at = screen.getByRole('button', { name: 'Insert an input into commands' });
    fireEvent.mouseDown(at);
    fireEvent.click(at);
    fireEvent.mouseDown(screen.getByRole('option', { name: /read-version\.read_version_result/ }));
    expect(onAddInput).toHaveBeenCalledWith(result);
    expect(onChange).toHaveBeenLastCalledWith('show {{ read_version_result }}');
    const list = screen.getByRole('listbox', { name: 'Fields of read_version_result' });
    expect(list.textContent).toContain('or go on typing to keep the whole result');
    fireEvent.mouseDown(screen.getByRole('option', { name: /read_version_result\.stdout\b/ }));
    expect(onChange).toHaveBeenLastCalledWith('show {{ read_version_result.stdout }}');
    expect(el.querySelector('[data-ref]')?.textContent).toBe('read_version_result.stdout');
    // The input was added once, with the result.
    expect(onAddInput).toHaveBeenCalledTimes(1);
  });

  it('a dot typed after a result chip offers its fields; Enter takes the one typed', () => {
    const { el, onChange } = withChoices('echo {{ read_version_result }}', [input]);
    typeAfterChip(el, '.');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    typeAfterChip(el, '.stdout_l');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'read_version_result.stdout_lines The value of stdout split into a list.',
    ]);
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('echo {{ read_version_result.stdout_lines }}');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a dot typed past an empty text node, as Chromium types after a chip', () => {
    const { el } = withChoices('{{ read_version_result }}', [input]);
    el.append(document.createTextNode(''));
    const dot = document.createTextNode('.');
    el.append(dot);
    select(dot, 1, dot, 1);
    fireEvent.input(el);
    expect(screen.getByRole('listbox', { name: 'Fields of read_version_result' })).toBeTruthy();
  });

  it('a dot after a chip that is no result stays text', () => {
    const { el, onChange } = withChoices('{{ hostname }}', [host, input]);
    typeAfterChip(el, '.lab.example');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith('{{ hostname }}.lab.example');
  });

  it('@ with a result and a dot offers its fields and adds the input', () => {
    const { el, onChange, onAddInput } = withChoices('', [result]);
    typeAfterChip(el, '@read_version_result.std');
    expect(
      screen.getByRole('listbox', { name: 'Fields of read_version_result' }).textContent,
    ).not.toContain('go on typing');
    fireEvent.mouseDown(screen.getByRole('option', { name: /read_version_result\.stdout\b/ }));
    expect(onAddInput).toHaveBeenCalledWith(result);
    expect(onChange).toHaveBeenLastCalledWith('{{ read_version_result.stdout }}');
  });
});
