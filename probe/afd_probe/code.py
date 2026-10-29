"""What Ansible compiles from the repository (M6, ADR-0012): plays and tasks with their origin
(file and line), tags, actions, registered variables and set facts. The flow's generated
playbooks are matched to nodes through `node_<ULID>` tags; bound roles are expanded through a
synthetic play that imports them (07 §5: dynamic includes are not expanded, only reported).
"""

from __future__ import annotations

import os
from typing import Any

AUTO_ACTIONS = {"validate_argument_spec", "ansible.builtin.validate_argument_spec"}
DYNAMIC_ACTIONS = {
    "include_tasks",
    "include_role",
    "ansible.builtin.include_tasks",
    "ansible.builtin.include_role",
    "include",
}
FACT_ACTIONS = {"set_fact", "ansible.builtin.set_fact"}
STATS_ACTIONS = {"set_stats", "ansible.builtin.set_stats"}


def _relative(root: str, path: str | None) -> str | None:
    if not path:
        return None
    norm = os.path.normpath(path)
    base = os.path.normpath(root)
    return (
        os.path.relpath(norm, base).replace(os.sep, "/") if norm.startswith(base + os.sep) else norm
    )


def _origin(root: str, obj: Any) -> dict | None:
    """`_origin` (ansible-core 2.19+) or the older `ansible_pos` of the data structure."""
    o = getattr(obj, "_origin", None)
    if o is not None and getattr(o, "path", None):
        return {"path": _relative(root, o.path), "line": getattr(o, "line_num", None)}
    pos = getattr(getattr(obj, "_ds", None), "ansible_pos", None)
    if pos:
        return {"path": _relative(root, pos[0]), "line": pos[1]}
    return None


def _names(value: Any) -> list[str]:
    """`register: x` (string) or the 2.21 form `{x: '_task.polymorphic_result'}`."""
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, dict):
        return [str(k) for k in value]
    return []


def _task(root: str, task: Any, section: str) -> dict | None:
    action = str(task.action or "")
    origin = _origin(root, task)
    # flush_handlers and other implicit meta tasks have no place in a file.
    if action == "meta" and origin is None:
        return None
    args = task.args if isinstance(task.args, dict) else {}
    facts: list[str] = []
    stats: list[str] = []
    if action in FACT_ACTIONS:
        facts = [str(k) for k in args if k != "cacheable"]
    if action in STATS_ACTIONS and isinstance(args.get("data"), dict):
        stats = [str(k) for k in args["data"]]
    role = getattr(task, "_role", None)
    return {
        "name": str(task.name or ""),
        "action": action,
        "tags": [str(t) for t in (task.tags or [])],
        "origin": origin,
        "register": _names(task.register),
        "facts": facts,
        "stats": stats,
        "role": role.get_name() if role is not None else None,
        "section": section,
        "dynamic": action in DYNAMIC_ACTIONS,
        "auto": action in AUTO_ACTIONS,
    }


def _flatten(
    root: str, blocks: list, section: str = "block", out: list | None = None
) -> list[dict]:
    out = [] if out is None else out
    for item in blocks:
        if hasattr(item, "block"):
            _flatten(root, item.block, section, out)
            _flatten(root, item.rescue, "rescue", out)
            _flatten(root, item.always, "always", out)
        else:
            t = _task(root, item, section)
            if t:
                out.append(t)
    return out


def _context(root: str):
    from ansible.inventory.manager import InventoryManager
    from ansible.parsing.dataloader import DataLoader
    from ansible.vars.manager import VariableManager

    loader = DataLoader()
    loader.set_basedir(root)
    # Compiling needs no hosts: an empty inventory keeps it offline and fast.
    inventory = InventoryManager(loader=loader, sources=["localhost,"])
    return loader, VariableManager(loader=loader, inventory=inventory)


def _error(exc: Exception) -> str:
    return " ".join(f"{type(exc).__name__}: {exc}".split())[:400]


def compile_code(
    root: str,
    playbooks: list[str] | None = None,
    roles: list[dict] | None = None,
) -> dict[str, Any]:
    from ansible.playbook import Playbook
    from ansible.playbook.play import Play

    loader, variables = _context(root)
    out: dict[str, Any] = {"playbooks": [], "roles": []}
    for path in playbooks or []:
        entry: dict[str, Any] = {"path": path, "plays": []}
        full = path if os.path.isabs(path) else os.path.join(root, path)
        if not os.path.isfile(full):
            entry["error"] = "not found"
            out["playbooks"].append(entry)
            continue
        try:
            book = Playbook.load(full, variable_manager=variables, loader=loader)
            for play in book.get_plays():
                entry["plays"].append(
                    {
                        "name": play.get_name(),
                        "hosts": str(play.hosts),
                        "tags": [str(t) for t in (play.tags or [])],
                        "origin": _origin(root, play),
                        "tasks": _flatten(root, play.compile()),
                    }
                )
        except Exception as exc:  # one broken playbook never stops the scan
            entry["error"] = _error(exc)
        out["playbooks"].append(entry)
    for spec in roles or []:
        name = str(spec.get("name") or "")
        tasks_from = spec.get("tasks_from") or None
        entry = {"name": name, "tasks_from": tasks_from, "tasks": []}
        include: dict[str, Any] = {"name": name}
        if tasks_from:
            include["tasks_from"] = tasks_from
        play_ds = {
            "name": "afd compile",
            "hosts": "localhost",
            "gather_facts": False,
            "tasks": [{"ansible.builtin.import_role": include}],
        }
        try:
            play = Play.load(play_ds, variable_manager=variables, loader=loader)
            entry["tasks"] = _flatten(root, play.compile())
        except Exception as exc:
            entry["error"] = _error(exc)
        out["roles"].append(entry)
    return out
