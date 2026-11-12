// AFD-224: Jinja in fields is coloured. Chip fields paint CSS highlights over their text (chips
// keep their own look); the YAML box colours spans in its layer. The text model maps the stored
// value to DOM points across chips, `<br>` and empty text nodes.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChipField } from '../../../src/webview/properties/ChipField';
import {
  offsetOf,
  pieces,
  pointAt,
  rangeOf,
  serialize,
} from '../../../src/webview/properties/editableText';
import { YamlField } from '../../../src/webview/properties/YamlField';

class FakeHighlight extends Set<AbstractRange> {}
const registry = new Map<string, FakeHighlight>();
const saved = {
  css: (globalThis as { CSS?: unknown }).CSS,
  hl: (globalThis as { Highlight?: unknown }).Highlight,
};

beforeAll(() => {
  (globalThis as { CSS?: unknown }).CSS = { highlights: registry };
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
});
afterAll(() => {
  (globalThis as { CSS?: unknown }).CSS = saved.css;
  (globalThis as { Highlight?: unknown }).Highlight = saved.hl;
});
afterEach(cleanup);

/** The text each colour's ranges cover, in document order. */
const painted = (colour: string) =>
  [...(registry.get(`afd-syn-${colour}`) ?? [])].map((r) => (r as Range).toString());

describe('chip field colours (AFD-224)', () => {
  it('paints the Jinja in the text, and leaves chips alone', () => {
    render(
      <ChipField
        id="f"
        value="/reports/{{ now(utc=true).strftime('%Y%m%d') }}/{{ host }}"
        onChange={() => {}}
        choices={[]}
        onAddInput={() => {}}
      />,
    );
    expect(document.querySelector('[data-ref="host"]')).toBeTruthy();
    expect(painted('func')).toEqual(['now', 'strftime']);
    expect(painted('var')).toEqual(['utc']);
    expect(painted('constant')).toEqual(['true']);
    expect(painted('format')).toEqual(['%Y%m%d']);
    expect(painted('string')).toEqual(["'", "'"]);
    // The chip's braces are not painted: two `{{` and two `}}` would be.
    expect(painted('delim')).toEqual(['{{', '}}']);
  });

  it('paints an expression field as one bare expression, with no chips', () => {
    render(
      <ChipField
        id="c"
        mode="expr"
        value="result.rc == 0 and item is not defined"
        onChange={() => {}}
        choices={[]}
        onAddInput={() => {}}
      />,
    );
    expect(document.querySelector('[data-ref]')).toBeNull();
    expect(painted('var')).toEqual(['result', 'rc', 'item']);
    expect(painted('keyword')).toEqual(['and', 'is', 'not']);
    expect(painted('func')).toEqual(['defined']);
  });

  it('drops its colours when it goes', () => {
    const { unmount } = render(
      <ChipField
        id="g"
        value="{{ a | b }}"
        onChange={() => {}}
        choices={[]}
        onAddInput={() => {}}
      />,
    );
    expect(painted('func')).toEqual(['b']);
    act(() => unmount());
    expect(painted('func')).toEqual([]);
  });
});

describe('the YAML box colours Jinja and bare keys (AFD-224)', () => {
  it('colours a when value as an expression and Jinja in a quoted value', () => {
    render(
      <YamlField
        id="y"
        value={{ when: 'result.rc == 0', loop: "{{ now().strftime('%H') }}" }}
        onChange={() => {}}
        bareKeys={new Set(['when'])}
      />,
    );
    const layer = document.querySelector('.afd-yaml-layer') as HTMLElement;
    const spans = (c: string) =>
      [...layer.querySelectorAll(`.afd-syn-${c}`)].map((e) => e.textContent);
    expect(spans('key')).toEqual(['when', 'loop']);
    expect(spans('var')).toEqual(['result', 'rc']);
    expect(spans('func')).toEqual(['now', 'strftime']);
    expect(spans('format')).toEqual(['%H']);
  });
});

describe('editableText', () => {
  function field(build: (el: HTMLElement) => void): HTMLElement {
    const el = document.createElement('div');
    build(el);
    document.body.append(el);
    return el;
  }
  const chip = (ref: string) => {
    const c = document.createElement('span');
    c.dataset.ref = ref;
    c.contentEditable = 'false';
    c.textContent = ref;
    return c;
  };

  it('maps offsets across chips, wrappers, empty text nodes and <br>', () => {
    const el = field((e) => {
      e.append('a ', chip('x'), document.createTextNode(''));
      const wrap = document.createElement('span');
      wrap.append('.b');
      e.append(wrap, document.createElement('br'));
    });
    expect(serialize(el)).toBe('a {{ x }}.b');
    expect(pieces(el).map((p) => [p.start, p.end, !!p.chip])).toEqual([
      [0, 2, false],
      [2, 9, true],
      [9, 9, false],
      [9, 11, false],
    ]);
    // A point inside a chip is its end; points between children map to the next piece.
    expect(offsetOf(el, el.childNodes[1]?.firstChild as Node, 0)).toBe(9);
    expect(offsetOf(el, el, 1)).toBe(2);
    expect(offsetOf(el, el, el.childNodes.length)).toBe(11);
    // An offset at a chip's edge lands in the text beside it.
    const [node, off] = pointAt(el, 9);
    expect(node.nodeType).toBe(Node.TEXT_NODE);
    expect(off).toBe(0);
    expect(rangeOf(el, 0, 11).toString()).toBe('a x.b');
    el.remove();
  });
});

/** Puts `text` in a chip field with the caret at its end, as typing its last character would. */
function typeInto(el: HTMLElement, text: string) {
  el.focus();
  el.textContent = text;
  const range = document.createRange();
  range.setStart(el.firstChild as Text, text.length);
  range.collapse(true);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.input(el, { data: text.slice(-1), inputType: 'insertText' });
}

function chipField(props: Partial<Parameters<typeof ChipField>[0]> = {}) {
  const changes: string[] = [];
  const added: string[] = [];
  render(
    <ChipField
      id="f"
      value=""
      onChange={(v) => changes.push(v)}
      choices={[]}
      onAddInput={(c) => added.push(c.name)}
      {...props}
    />,
  );
  return { el: screen.getByRole('textbox'), changes, added };
}

describe('completion in a chip field (AFD-226)', () => {
  it("offers strftime's formats after now(utc=true).str, and Enter puts one in, closing the braces", () => {
    const { el, changes } = chipField();
    typeInto(el, '{{ now(utc=true).str');
    const list = screen.getByRole('listbox', { name: 'Members' });
    expect(within(list).getByRole('option', { name: /strftime\('%Y%m%d_%H%M%S'\)/ })).toBeTruthy();
    // The help under the list: the active item's signature and what it does.
    expect(document.querySelector('.afd-jinja-doc')?.textContent).toContain('strftime(format)');
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(changes.at(-1)).toBe("{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}");
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens the format codes inside a picked strftime(), and Escape closes the list only', () => {
    const { el, changes } = chipField();
    typeInto(el, '{{ now().strf');
    fireEvent.mouseDown(screen.getByRole('option', { name: /^strftime\(''\)/ }));
    expect(changes.at(-1)).toBe("{{ now().strftime('') }}");
    expect(screen.getByRole('listbox', { name: 'Date formats' })).toBeTruthy();
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(el.textContent).toBe("{{ now().strftime('') }}");
  });

  it('puts the choice in through insertText where the browser has it (Ctrl+Z takes it back)', () => {
    const calls: string[] = [];
    const exec = vi.fn((cmd: string, _ui: boolean, text: string) => {
      calls.push(`${cmd}:${text}`);
      const range = window.getSelection()?.getRangeAt(0) as Range;
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      return true;
    });
    document.execCommand = exec as unknown as typeof document.execCommand;
    try {
      const { el, changes } = chipField();
      typeInto(el, '{{ x | def');
      fireEvent.keyDown(el, { key: 'Tab' });
      expect(calls).toEqual(["insertText:default('') }}"]);
      expect(changes.at(-1)).toBe("{{ x | default('') }}");
    } finally {
      (document as { execCommand?: unknown }).execCommand = undefined;
    }
  });

  it('offers the node variables, and a pick that is not an input yet stages it', () => {
    const staged = {
      name: 'target_image',
      label: 'flow.target_image',
      detail: 'flow input',
      field: { type: 'string' as const, from: 'flow.target_image' },
    };
    const { el, changes, added } = chipField({ choices: [staged] });
    typeInto(el, 'boot {{ targ');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(changes.at(-1)).toBe('boot {{ target_image }}');
    expect(added).toEqual(['target_image']);
  });

  it('shows the arguments of the call the caret is in, and Ctrl+Space opens the list', () => {
    const { el } = chipField();
    typeInto(el, "{{ lookup('env', ");
    expect(document.querySelector('[data-jinja-hint]')?.textContent).toContain(
      'lookup(name, *terms, wantlist=False, **options)',
    );
    expect(document.querySelector('[data-jinja-hint] strong')?.textContent).toBe('*terms');
    typeInto(el, '{{ ');
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(el, { key: ' ', ctrlKey: true });
    expect(screen.getByRole('listbox', { name: 'Variables and functions' })).toBeTruthy();
  });

  it('in an expression field, @ puts in a bare name, never a chip', () => {
    const result = { name: 'version_result', label: 'version_result', detail: 'from Read version' };
    const { el, changes } = chipField({ mode: 'expr', choices: [result] });
    el.focus();
    fireEvent.mouseDown(screen.getByRole('button', { name: /Insert an input/ }));
    fireEvent.click(screen.getByRole('button', { name: /Insert an input/ }));
    fireEvent.mouseDown(screen.getByRole('option', { name: /version_result/ }));
    expect(document.querySelector('[data-ref]')).toBeNull();
    expect(changes.at(-1)).toBe('version_result');
  });
});

describe('completion in the YAML box (AFD-226)', () => {
  async function typeYaml(box: HTMLTextAreaElement, text: string) {
    box.focus();
    fireEvent.input(box, {
      target: { value: text },
      data: text.slice(-1),
      inputType: 'insertText',
    });
    box.setSelectionRange(text.length, text.length);
    await act(() => new Promise((r) => setTimeout(r, 0)));
  }

  it('completes a bare when value with a bare name', async () => {
    render(<YamlField id="k" value={undefined} onChange={() => {}} bareKeys={new Set(['when'])} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await typeYaml(box, 'when: inv');
    expect(screen.getByRole('listbox', { name: 'Variables and functions' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('when: inventory_hostname');
  });

  it('writes a picked quote as YAML writes it inside a single-quoted value', async () => {
    render(<YamlField id="v" value={undefined} onChange={() => {}} />);
    const box = screen.getByRole('textbox') as HTMLTextAreaElement;
    await typeYaml(box, "ts: '{{ now(utc=true).strf");
    fireEvent.mouseDown(screen.getByRole('option', { name: /strftime\('%Y%m%d_%H%M%S'\)/ }));
    expect(box.value).toBe("ts: '{{ now(utc=true).strftime(''%Y%m%d_%H%M%S'') }}");
  });
});
