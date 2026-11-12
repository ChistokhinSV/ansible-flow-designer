# ADR-0034: Jinja in fields: colours, completion and help without an editor component

- Status: accepted (2026-11-12, AFD-221)
- Context: fields of the Details panel showed Jinja as plain text; the product owner asked for
  VS Code's Jinja colours, completion as you type (`now(utc=true).str` → strftime with its
  formats) and inline help, in every field that takes Jinja

## Context

Real flows keep values like `{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}` in set_fact facts,
parameters and Task keywords. The fields that hold Jinja are of three kinds: chip fields
(contenteditable, `{{ name }}` as a chip), the YAML box (a textarea over a coloured layer, AFD-103),
and plain inputs for a decision's Condition and Until.

ADR-0023 (AFD-103) chose an in-house tokenizer over an editor component for the YAML box, and the
webview had about 16 KB left in its budget. A webview gets the theme's workbench colours as CSS
variables, but not its token colours.

Product-owner decisions (2026-11-12):

- All Jinja fields: parameters, list items, variables and facts, Timing fields, the Task keywords
  box, and the bare-expression fields (Condition, Until, assert `that`, debug `var`).
- Inline help: docs under the list, a live date preview, a call signature hint, hover help.
- Colours similar to VS Code's defaults.

## Decision

- **No editor library.** A lossless tokenizer (`core/view/jinjaText.ts`: template and expression
  modes, YAML quoting, whitespace control, raw blocks, half-typed input) colours the fields and
  tells the completion engine where the caret is (the open string, call and argument). A test
  checks that what it colours as variables is what the checks read (`parseRefs`, `exprRefs`).
- **Colours:** VS Code's default token colours per theme kind (Dark+, Light+, the high-contrast
  themes), folded by scope into `--afd-syn-*` (`webview/theme/tokens.ts`, `SYNTAX`). Two Dark+
  colours are nudged to reach 4.5:1 on Dark Modern's input background. Custom colour themes are
  not followed: the host would have to find and merge the theme's JSON.
- **Chip fields** paint with the **CSS Custom Highlight API** (`::highlight(afd-syn-<colour>)`):
  ranges over the text, with no DOM change, so the caret, native Undo, IME and chips stay as they
  are. It needs Chromium 105 (VS Code 1.94, the engine floor, has 124); without it, plain text.
  `properties/editableText.ts` maps the stored value to DOM points across chips, `<br>`, wrappers
  and empty text nodes.
- **The YAML box** keeps its layer; values are scanned as Jinja inside their quotes, and the values
  of `when`, `changed_when` and `failed_when` (and list items under them) as expressions.
- **Completion** (`core/view/jinjaComplete.ts`, pure): the node's variables (`refChoices`), magic
  variables, globals, filters after `|`, tests after `is`, a value's members after `.` (a small
  type walk: `now()` is a datetime, a string literal a str, a result's fields from its module's
  returns), date formats and codes inside `strftime(`, lookups inside `lookup(`. The words and their
  one-line docs are ours (`core/view/jinjaVocabulary.ts`); ansible-doc never lists Jinja's
  built-ins. The catalog adds the environment's filters, tests and lookups (`names`), from the
  loaded index only: asking never starts the probe.
- **The list** opens as VS Code's suggestions open (identifier characters, `.`, `|`, quotes, `(`),
  Ctrl+Space opens it anywhere; it is fixed-positioned under the caret's line (`menuPlace.ts`), so
  it neither widens nor scrolls a narrow column. A choice goes in with `execCommand('insertText')`,
  so Ctrl+Z takes it back; only from key and mouse handlers (AFD-79), with a DOM edit where the
  browser refuses. Inside a quoted YAML value a quote goes in as YAML writes it there.
- **Help:** the active entry's signature, doc and date preview under the list; the arguments of
  the call the caret is in on a line under the field; a name's help on hover.
- **Bare expressions** (Condition, Until, assert `that`, debug `var`) are chip fields in expression
  mode: no chips, `@` puts in a bare name, and a variable picked that is not an input yet is saved
  with the value (`useCommitDraft`, shared with the Timing fields).

## Consequences

- The webview bundle grew by about 55 KB; a minify pass (ADR-0023 amendment, AFD-223) had taken it
  from 1,200 KB to 893 KB first.
- jsdom has no layout, no `Highlight` and no `execCommand`: tests stub the highlight registry and
  check placement in core; the screenshots (`jinja-colours`, `jinja-complete`) show the real thing.
- Not done: following a custom colour theme; completion of a variable's members by its contract
  type; hover help in the YAML box for words outside coloured spans.
