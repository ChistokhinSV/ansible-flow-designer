# Accessibility checklist

Run it for every surface in light, dark and high contrast (VS Code's _High Contrast_ and _High
Contrast Light_ themes), with the keyboard only, and once with a screen reader (NVDA or Narrator on
Windows). Results: ✅ passes, ⚠ partly, ❌ fails. The baseline column is 0.23.x (AFD-33); later
waves add a column. Wave 3 adds jsdom checks of its own (`test/unit/webview/a11y.test.tsx`): every
control named and every field labelled in each mode, ports, keyboard pick, dialog focus, the core
tasks by keyboard.

## Every surface

- **Reach:** every action can be reached with Tab, the arrow keys, Enter and Escape.
- **Focus visible:** the focused element shows VS Code's focus outline.
- **Names:** controls have names that say what they do (no icon-only button without a label).
- **Dialogs:** focus moves into a dialog when it opens, stays there, and returns where it was when
  it closes; Escape closes only the innermost one.
- **Contrast:** text at least 4.5:1, ports, wires and focus at least 3:1 (the theme token check
  covers the tokens; screenshots cover the rest).
- **Motion:** nothing animates when the system asks for reduced motion.
- **Forced colours:** state is not shown by colour alone (Windows contrast themes).

## Surfaces

| Surface                                     | Check                                                                         | Baseline                                                     | Wave 3 (0.27)                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Top bar                                     | modes, lens, run actions and "…" reachable and named                          | ✅                                                           | ✅ and Alt+1/2/3 for the modes                         |
| Top bar                                     | breadcrumb items are links; the current level is marked                       | ✅ (since AFD-30)                                            | ✅                                                     |
| Palette                                     | node types and patterns reachable; patterns say they need a selected node     | ⚠ only in a tooltip                                          | ✅ a hint on screen, read with each pattern            |
| Canvas                                      | nodes focusable, named with type, title, status and open problems             | ⚠ type and title only                                        | ✅ type, title, status, open fail ports                |
| Canvas                                      | ports focusable, Enter opens the port menu                                    | ❌ ports are pointer-only                                    | ✅ on the selected node                                |
| Canvas                                      | pick mode ("Connect to…") can be finished with the keyboard                   | ❌                                                           | ✅ Tab or arrows, then Enter                           |
| Canvas                                      | node menu (Shift+F10 or the Menu key)                                         | ✅                                                           | ✅                                                     |
| Canvas                                      | find a node; fit; select all with the keyboard                                | ❌ no find, no shortcut for fit; select all only in the menu | ✅ Ctrl+F, Shift+1, Ctrl+A                             |
| Canvas                                      | state readable without colour (status, run results, lens)                     | ⚠ status has a text sub-line; run tones are colour plus text | ✅ status icon (AFD-42) and text                       |
| Port and context menus                      | arrow keys, Enter, Escape; focus returns                                      | ✅ (`Menu.tsx`)                                              | ✅ also to the opener of a menu that opened a dialog   |
| Quick add                                   | focus on the title; Escape cancels; focus returns                             | ⚠ focus does not return                                      | ✅                                                     |
| Inspector                                   | fields labelled; read-only state announced                                    | ⚠ read-only shown as disabled fields only                    | ⚠ labelled (jsdom check); read-only as disabled fields |
| Properties page                             | focus moves in when it opens and is kept there; tabs work with the arrow keys | ❌ no initial focus, no trap, no arrow keys on tabs          | ✅ docked Details: Enter moves in, arrows switch tabs  |
| Properties page                             | Escape with unsaved changes asks first                                        | ✅ (since AFD-30)                                            | ✅                                                     |
| Dialogs (leave open, ignore, mark expected) | focus trap and return                                                         | ⚠ focus moves in, not trapped, not returned                  | ✅ every modal                                         |
| Banners and toasts                          | announced (`role="status"` / `alert`), dismissible, not timed out too fast    | ⚠ the error toast hides after 6 s, no close button           | ✅ (AFD-46)                                            |
| Cheat sheet                                 | lists every shortcut (including redo)                                         | ⚠ redo missing                                               | ✅                                                     |
| Whole designer                              | reduced motion and forced colours handled                                     | ❌ no `prefers-reduced-motion` or `forced-colors` rules      | ✅ (AFD-36)                                            |

## Annotations (wave 6, 0.42)

Notes, Sections and Text (AFD-65, ADR-0028). Checked with jsdom (`test/unit/webview/annotations.test.tsx`) and in the harness.

| Check                                                                  | Wave 6 (0.42)                                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| reached with Tab after the steps; named by kind and first line         | ✅ "Note: …", "Section: …", "Text: …"; ties are hidden from readers                      |
| add, edit, delete with the keyboard                                    | ✅ Shift+N (on the selected node), Enter or F2, Ctrl+Enter saves, Escape cancels, Delete |
| menu (Shift+F10 or the Menu key); Attach to Node… finished by keyboard | ✅ the pick mode's Tab or arrows, then Enter                                             |
| editor field labelled                                                  | ✅ "Annotation text (Markdown); Ctrl+Enter saves, Escape cancels"                        |
| links open only through the host                                       | ✅ http(s) links found in the flow's annotations                                         |
| colours meet contrast; forced colours show a border, not a tint        | ✅ theme token check; `19-motion-and-forced-colours.css`                                 |
| a Section's body lets clicks, pan and box select through to the steps  | ✅ only its title bar and resize handles take the pointer                                |

## First hour (wave 7, 0.49)

Folds, the open-port banner, the Wire panel, the first-flow checklist and the Ansible Flows view
(AFD-72, AFD-73). Checked with jsdom (`navigation`, `properties`, `canvas`, `firstFlow` tests) and in
the harness.

| Check                                                                     | Wave 7 (0.49)                                                                                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| folds open and close with the keyboard; their summary says what is inside | ✅ native `<details>`: Tab to the summary, Enter or Space                                                                  |
| a fold that holds a problem or a value opens by itself                    | ✅ an invalid key, a set setting, the branching types on a level that has them                                             |
| the banner's question and choices are reached with Tab and named          | ✅ the step title is a link; patterns, Accept with Reason…, Other Choices and Next are buttons; `role=status`              |
| the Wire panel says which hosts take the wire, in words                   | ✅ "Hosts that leave X by `port` go to Y", with the port's meaning                                                         |
| the checklist is reached with Tab; Show Me says what it does              | ✅ `<details>` summary "Your first flow · n of 4"; each button is labelled "Show me: …"                                    |
| "?" links are named                                                       | ✅ "Help: the General tab", "Help: failure patterns"…                                                                      |
| the Ansible Flows view and its welcome are VS Code's own tree and links   | ✅                                                                                                                         |
| port hints reach screen readers                                           | ⚠ in the tooltip (`title`) and the port menu header; a port's accessible name stays "Port failed_hosts, open: not handled" |

## Wave 8 (0.51+)

| Check                                                                                                                             | Wave 8                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding tab: the parameter picker is a combobox (AFD-80, 0.51)                                                                    | ✅ `role=combobox` with `aria-expanded`, `aria-controls`, `aria-activedescendant`; arrows, Enter, Escape; labelled "Add a parameter"        |
| Binding tab: Change module and About are folds (AFD-80)                                                                           | ✅ native `<details>`, the summary names the module; Change module opens by itself when the binding is a problem                            |
| leaving a staged binding by hiding the panel or the lens tab asks first (AFD-80)                                                  | ✅ the leave dialog (focus on Keep Editing)                                                                                                 |
| the side panel's resize edge is visible at rest (AFD-80)                                                                          | ✅ a grip; `role=separator` with its value, arrows resize, Enter hides                                                                      |
| a live run's step is shown without colour or motion alone (AFD-81, 0.52)                                                          | ✅ "running…" on the card and "Running: <step>" in the top bar; the outline stops under reduced motion and uses Highlight in forced colours |
| a host's run output opens with the keyboard (AFD-81)                                                                              | ✅ an Output button per host with `aria-expanded`, named "Output of <host>"                                                                 |
| launch dialog: focus in, trapped and back; Escape cancels (AFD-82, 0.53)                                                          | ✅ `role=dialog`, labelled by its title; first field focused; Enter runs (a form)                                                           |
| launch dialog: fields named with their type; problems announced                                                                   | ✅ "devices host_list *"; a field that does not read gets `aria-invalid` and its message; facts are `role=status`                           |
| launch dialog: group buttons say whether they are in the list                                                                     | ✅ `aria-pressed`, in a fieldset named "Inventory groups for <input>"                                                                       |
| the canvas caption (mode, lens, why empty) is read out (AFD-83, 0.54)                                                             | ✅ `role=status`; Set Targets… is a button                                                                                                  |
| the Inventory view is VS Code's own tree; Run Flow on This Group… is named                                                        | ✅ an inline action with its title; groups say their host count                                                                             |
| scenarios in the run panel: each a button saying pass or fail and who ended elsewhere, ends by title (AFD-84, 0.55; AFD-94, 0.62) | ✅ `aria-pressed` on the one on the canvas; Back to Last Run is a button                                                                    |
| changed outside the designer: said in words, not only dashed (AFD-85, 0.56)                                                       | ✅ the note is `role=status` with counts; Show and Clear are buttons; the legend names the dashed outline                                   |
| Find filters are offered as buttons; the count is announced (AFD-86, 0.57)                                                        | ✅ hint buttons under the box; results stay a listbox with `aria-activedescendant`; "N found" is `aria-live`                                |
| Readiness counts are buttons that say what they list                                                                              | ✅ `title` "List the draft steps on every level (Find status:draft)"                                                                        |
| the Flows view's states are in words                                                                                              | ✅ the description says "2 errors · code out of date"; the tooltip explains it                                                              |
| a step's lens findings in Details are a native fold with the same buttons (AFD-87, 0.58)                                          | ✅ `<details>` summary "Lens: Inventory · 1 on this step"; "No … findings left" is `role="status"`                                          |
| after a fix the focus moves on instead of being lost (AFD-87)                                                                     | ✅ to the next open finding's first button, else the Findings heading (`tabIndex -1`)                                                       |
| where a finding's step is, in words                                                                                               | ✅ "· in Drain the switch" in the row's text                                                                                                |
| Align and Distribute have keys and buttons, not only the drag (AFD-88, 0.59)                                                      | ✅ Shift+Alt+A / Shift+Alt+D; buttons in the selection panel; the menu's Arrange ▸                                                          |
| drag guides are visual help only, never the only way                                                                              | ✅ `aria-hidden`; the same result from Arrange; Highlight in forced colours                                                                 |
| drop on a wire has a keyboard path                                                                                                | ✅ the wire's Insert Node on This Wire (menu, Enter on the port)                                                                            |
| the Flows View link in the flow panel is a button with its words (AFD-89, 0.59.1)                                                 | ✅ "Flows View" after the sentence that says what it shows                                                                                  |
| lens rows keep their size when a click opens another level (AFD-91, 0.59.3)                                                       | ✅ the place line depends on the list, not the level; a nested step's hover lights its subflow                                              |
| marks for a flow changed while closed say since when, in words (AFD-92, 0.60)                                                     | ✅ the note's `role=status` text names the day and time                                                                                     |
| the workspace's line in the flow panel and the Find summary are text with a real button (AFD-93, 0.61)                            | ✅ "Flows View" is a button; the summary is plain text before the listbox, outside it                                                       |
| launch dialog: groups labelled, with their hosts; Run stays in view (AFD-95, 0.63)                                                | ✅ a visible "Inventory groups" legend; the count is `aria-hidden`, the hosts in `title`; the actions are sticky inside the dialog          |
| Run Results link and the Output icon in a step's Run tab (AFD-96, 0.64)                                                           | ✅ a link with its words; the icon button keeps "Output of <host>" as its name and tooltip, and `aria-expanded`                             |
