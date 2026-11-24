# Capture at a pause (ADR-0040 §3, AFD-361): a host's variables by scope, masked, as JSON-safe
# values, with a size per value and per answer. Only at a pause, only when asked, from one
# variable_manager.get_vars(play, host) per host per pause.
#
# Scopes:
# - inputs: the step's inputs (its play vars, ADR-0011), as written: a template stays text;
# - host: inventory variables, set_fact values and registers;
# - flow: the run's extra vars (the flow's inputs and carried data);
# - facts: ansible_facts, only when asked for (expensive).
# Never sent: `vars` (2.19+: every variable again), `hostvars` (walking it renders every variable
# of every host and runs their lookups) and the other magic variables.
from __future__ import annotations

import contextlib
import datetime
import json
import math
import re
from collections.abc import Mapping

from .mask import SECRET_NAME, Masked, Masker

try:
    from ansible._internal._datatag._tags import TrustedAsTemplate
    from ansible.module_utils._internal._datatag import AnsibleTagHelper
    from ansible.parsing.vault import EncryptedString

    TAGS = True
except ImportError:  # pragma: no cover
    TAGS = False

VALUE_LIMIT = 64 * 1024
ANSWER_LIMIT = 1024 * 1024
PAGE = 100
DEPTH = 40
SCOPES = ("inputs", "host", "flow", "facts")
SCOPE_NAMES = {
    "inputs": "Step inputs",
    "host": "Host variables",
    "flow": "Flow data",
    "facts": "Facts",
}

MAGIC = {
    "hostvars", "groups", "group_names", "inventory_hostname", "inventory_hostname_short",
    "inventory_dir", "inventory_file", "play_hosts", "playbook_dir", "role_names", "omit",
    "environment", "ansible_play_hosts", "ansible_play_hosts_all", "ansible_play_batch",
    "ansible_play_name", "ansible_play_role_names", "ansible_role_names", "ansible_version",
    "ansible_check_mode", "ansible_diff_mode", "ansible_forks", "ansible_inventory_sources",
    "ansible_playbook_python", "ansible_config_file", "ansible_verbosity", "ansible_run_tags",
    "ansible_skip_tags", "ansible_dependent_role_names", "ansible_collection_name",
    "ansible_search_path", "ansible_loop_var", "ansible_index_var", "ansible_parent_role_names",
    "ansible_parent_role_paths", "ansible_role_name", "ansible_vault_id", "vars",
}  # fmt: skip
# The generator's own play variables: not inputs of the step (afd_repo_root, afd_* data names).
OWN_PLAY_VARS = {"flow_node_id", "afd_sim", "afd_repo_root"}
# The record inputs task marks an input the flow knows is secret with this constant (AFD-341).
SECRET_MARK = "__afd_secret__"
_MARKED = re.compile(r"'([A-Za-z_][A-Za-z0-9_]*)'\s*:\s*'" + SECRET_MARK + "'")
# Every input the record inputs task names: `'devices': (('__afd_vault__' ...` or a secret's mark.
_INPUT = re.compile(r"'([A-Za-z_][A-Za-z0-9_]*)'\s*:\s*(?:\(|'" + SECRET_MARK + "')")


def plain(value: object, depth: int = 0) -> object:
    """A JSON-safe copy: masked parts as markers, vaulted values never decrypted, a template as
    its text (flagged), odd types described."""
    if isinstance(value, Masked):
        return {"__afd__": "masked", "masked": value.kind}
    if depth > DEPTH:
        return {"__afd__": "deep"}
    if TAGS and isinstance(value, EncryptedString):
        return {"__afd__": "masked", "masked": "vault"}
    if type(value).__name__ in ("HostVars", "HostVarsVars"):
        return {"__afd__": "lazy", "type": "hostvars"}
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value) if math.isfinite(value) else str(value)
    if isinstance(value, str):
        text = str.__str__(value)
        if "{{" in text or "{%" in text:
            try:
                if not TAGS or TrustedAsTemplate in AnsibleTagHelper.tag_types(value):
                    return {"__afd__": "template", "text": text}
            except Exception:  # noqa: BLE001
                pass
        return text
    if isinstance(value, Mapping):
        return {str(k): plain(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [plain(v, depth + 1) for v in value]
    if isinstance(value, bytes):
        return {"__afd__": "bytes", "size": len(value)}
    if isinstance(value, (datetime.date, datetime.time)):
        return value.isoformat()
    try:
        shown = repr(value)[:200]
    except Exception as ex:  # noqa: BLE001 - an Undefined's repr may raise
        shown = f"<{type(ex).__name__}>"
    return {"__afd__": type(value).__name__, "repr": shown}


def type_of(value: object) -> str:
    """The type a client shows: a marker's kind, or the JSON type."""
    if isinstance(value, dict):
        marker = value.get("__afd__")
        if isinstance(marker, str):
            return marker
        return "dict"
    if isinstance(value, list):
        return "list"
    if isinstance(value, bool):
        return "bool"
    if value is None:
        return "null"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    return "str"


def to_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def entry(name: str | int, value: object) -> dict:
    """One variable or item, as a list shows it: name, type, size; a scalar's value (cut at
    VALUE_LIMIT), a container's count. A masked value says why, never its size."""
    kind = type_of(value)
    out: dict[str, object] = {"name": name, "type": kind}
    if kind == "masked":
        out["masked"] = value["masked"]  # type: ignore[index]
        return out
    if kind == "dict" or kind == "list":
        out["count"] = len(value)  # type: ignore[arg-type]
        out["size"] = len(to_json(value))
        return out
    text = to_json(value)
    out["size"] = len(text)
    if kind == "str" and len(value) > VALUE_LIMIT:  # type: ignore[arg-type]
        out["value"] = value[:VALUE_LIMIT]  # type: ignore[index]
        out["cut"] = len(value)  # type: ignore[arg-type]
    elif len(text) > VALUE_LIMIT:
        out["value"] = text[:VALUE_LIMIT]
        out["cut"] = len(text)
    else:
        out["value"] = value
    return out


def _walk_tasks(items: list, visit, depth: int = 0) -> None:
    for item in items or []:
        if depth < 8 and hasattr(item, "block"):
            for part in ("block", "rescue", "always"):
                _walk_tasks(getattr(item, part, None) or [], visit, depth + 1)
            continue
        visit(item)


def nolog_registers(play) -> set[str]:
    """The variables a no_log task of the play registers: from 2.19 a register keeps the task's
    whole result, without the _ansible_no_log flag."""
    found: set[str] = set()

    def visit(task) -> None:
        register = getattr(task, "register", None)
        no_log = getattr(task, "no_log", None)
        if not register or no_log in (None, False, "false", "False", "no"):
            return
        # 2.21: a mapping of names to what each registers; before: one name.
        names = list(register) if isinstance(register, Mapping) else [register]
        found.update(str(n) for n in names)

    with contextlib.suppress(Exception):
        for part in ("pre_tasks", "tasks", "post_tasks", "handlers"):
            _walk_tasks(list(getattr(play, part, None) or []), visit)
    return found


def step_inputs(play) -> set[str]:
    """The step's inputs by name, as its record inputs task lists them: an input the flow data
    gives (`devices`) is an extra variable, not a play variable, and is a step input too."""
    found: set[str] = set()

    def visit(task) -> None:
        if str(getattr(task, "name", "") or "").endswith("] record inputs"):
            for v in (getattr(task, "args", None) or {}).values():
                found.update(_INPUT.findall(str.__str__(str(v))))

    with contextlib.suppress(Exception):
        _walk_tasks(list(play.tasks or []), visit)
    return found


def secret_inputs(play) -> set[str]:
    """The inputs the flow knows are secret: the record inputs task writes them as a constant."""
    found: set[str] = set()

    def visit(task) -> None:
        if str(getattr(task, "name", "") or "").endswith("] record inputs"):
            for v in (getattr(task, "args", None) or {}).values():
                found.update(_MARKED.findall(str.__str__(str(v))))

    with contextlib.suppress(Exception):  # nothing more known: the other checks still run
        _walk_tasks(list(play.tasks or []), visit)
    return found


class HostView:
    """A host's variables at one pause: masked and made plain once, then listed and paged."""

    def __init__(
        self,
        all_vars: Mapping,
        *,
        play_vars: set[str],
        extra: set[str],
        secret: set[str],
        masker: Masker,
        nolog: set[str] | None = None,
        inputs: set[str] | None = None,
    ) -> None:
        self._vars = all_vars
        self._play_vars = {n for n in play_vars - OWN_PLAY_VARS if not str(n).startswith("afd_")}
        self._inputs = (inputs or set()) | self._play_vars
        self._all_play = play_vars
        self._extra = extra
        self._secret = secret
        self._nolog = nolog or set()
        self._masker = masker
        self._scopes: dict[str, dict[str, object]] = {}
        # A value under a secret-looking name is learned, so its copies are caught. Magic variables
        # are not: they hold host and group names (groups: flow_<step>_ok_hosts, where a step key
        # may look secret), and `vars` holds every variable again. Nor is a no_log register: it is
        # masked whole by its name. Learning them masked a host's name for the rest of the run.
        for name, v in all_vars.items():
            if str(name) in MAGIC or str(name) in self._nolog:
                continue
            masker.learn(v, secret=bool(SECRET_NAME.search(str(name))))

    def scope_of(self, name: str) -> str | None:
        if name in MAGIC or name in OWN_PLAY_VARS or name.startswith("ansible_facts"):
            return None
        if name not in self._extra and name.startswith("afd_"):
            # The generator's own: its play variables and the facts its code sets on a host
            # (afd_failed_node, afd_failed_result, afd_failed_task, afd_inputs). Evaluate still
            # reads them.
            return None
        if name in self._extra:
            return "flow"
        if name in self._play_vars:
            return "inputs"
        facts = self._vars.get("ansible_facts")
        if isinstance(facts, Mapping) and name.startswith("ansible_") and name[8:] in facts:
            return None  # a fact again, as a variable (INJECT_FACTS_AS_VARS)
        if name == "ansible_local":
            return None
        return "host"

    def scope(self, scope: str) -> dict[str, object]:
        """The scope's values by name, plain and masked."""
        if scope in self._scopes:
            return self._scopes[scope]
        out: dict[str, object] = {}
        if scope == "facts":
            facts = self._vars.get("ansible_facts")
            if isinstance(facts, Mapping):
                for name in sorted(facts, key=str):
                    out[str(name)] = plain(self._masker.mask(str(name), facts[name]))
        else:
            for name in sorted(self._vars, key=str):
                where = self.scope_of(str(name))
                # A step input the flow data gives is listed in both: it is the step's input.
                if not (where == scope or (scope == "inputs" and where and name in self._inputs)):
                    continue
                if scope == "inputs" and name in self._secret:
                    out[name] = plain(Masked("credential"))
                    continue
                if scope == "host" and name in self._nolog:
                    out[name] = plain(Masked("no_log"))
                    continue
                out[name] = plain(self._masker.mask(str(name), self._vars[name]))
        self._scopes[scope] = out
        return out

    def scopes(self, facts: bool = False) -> list[dict]:
        """Every scope with its variables' names, types and sizes, no values."""
        out = []
        for scope in SCOPES:
            item: dict[str, object] = {"id": scope, "name": SCOPE_NAMES[scope]}
            if scope == "facts":
                item["expensive"] = True
                if not facts:
                    out.append(item)
                    continue
            names = []
            for name, value in self.scope(scope).items():
                e = entry(name, value)
                e.pop("value", None)
                e.pop("cut", None)
                names.append(e)
            item["vars"] = names
            out.append(item)
        return out

    def page(self, scope: str, path: list, start: int = 0, count: int = PAGE) -> dict:
        """The value at `path` in a scope: a scalar whole (cut), a container's items paged."""
        node: object = self.scope(scope)
        for i, key in enumerate(path):
            if isinstance(node, dict) and type_of(node) == "dict" and str(key) in node:
                node = node[str(key)]
            elif isinstance(node, list) and isinstance(key, int) and 0 <= key < len(node):
                node = node[key]
            else:
                where = "/".join(str(p) for p in path[: i + 1])
                return {"error": f"no such variable: {where}"}
        kind = type_of(node)
        if path and kind not in ("dict", "list"):
            return entry(path[-1], node)
        items: list[tuple[str | int, object]] = (
            list(node.items()) if isinstance(node, dict) else list(enumerate(node))  # type: ignore[union-attr]
        )
        start = max(0, int(start))
        count = max(1, min(int(count), 1000))
        children = []
        used = 0
        more = False
        for name, value in items[start : start + count]:
            e = entry(name, value)
            size = len(to_json(e))
            if children and used + size > ANSWER_LIMIT:
                more = True
                break
            used += size
            children.append(e)
        if start + len(children) < len(items):
            more = True
        out: dict[str, object] = {
            "type": kind if path else "scope",
            "total": len(items),
            "start": start,
            "children": children,
        }
        if more:
            out["more"] = True
        return out
