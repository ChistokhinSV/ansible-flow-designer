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
