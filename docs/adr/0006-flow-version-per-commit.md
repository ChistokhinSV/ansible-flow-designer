# ADR-0006 · `flow.version` bumps once per commit

Status: Accepted · 2026-10-28 · AFD-1

## Context
03 says the version is "bumped on each saved change". Applied literally, a layout drag would touch `flow:` and every autosave would bump.

## Decision
On save (`onWillSaveTextDocument` → `waitUntil`): if the semantic content (the document without `layout`, as canonical JSON) differs from the committed file at Git HEAD and `version` still equals HEAD's version, set `version` to HEAD's + 1. HEAD content comes from the built-in `vscode.git` API (`repository.show('HEAD', path)`), so it works under VS Code Remote. Outside Git, compare with the last saved text instead. Layout-only changes never bump.

## Consequences
One bump per commit, stable under autosave; opening and saving an unchanged flow never changes it.
