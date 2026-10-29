"""Module catalog dump (M5, ADR-0011): what the environment can run, normalized for the host index.

`ansible-doc --metadata-dump` is internal, so everything it returns goes through `_plugin`. One
process per collection runs in parallel (07 §2: 37 s instead of 257 s for 93 collections), and a
collection is dumped again only when its version or ansible-core's minor version changed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

DUMP_TIMEOUT = 600
KEPT_TYPES = ("module", "filter", "test", "lookup", "keyword")
FORMAT = 1

# Ansible doc markup → text; code-like parts keep backticks so the UI can show them as code.
_MARKUP = [
    (re.compile(r"L\(([^)]*?),\s*([^)]*?)\)"), r"\1 (\2)"),
    (re.compile(r"[CMOVRPE]V?\(([^)]*)\)"), r"`\1`"),
    (re.compile(r"[IBU]\(([^)]*)\)"), r"\1"),
    (re.compile(r":(?:ref|class|meth|func|attr|term):`([^`<]*?)(?:\s*<[^>]*>)?`"), r"\1"),
    (re.compile(r"HORIZONTALLINE"), ""),
]


def text(value: Any) -> str:
    """Ansible doc strings (or lists of them) as one plain paragraph text."""
    if value is None:
        return ""
    parts = value if isinstance(value, list) else [value]
    out = []
    for part in parts:
        s = str(part)
        for pattern, repl in _MARKUP:
            s = pattern.sub(repl, s)
        out.append(s.strip())
    return "\n".join(p for p in out if p)


def _option(opt: dict) -> dict:
    out: dict[str, Any] = {
        "type": opt.get("type") or "str",
        "description": text(opt.get("description")),
    }
    for key in ("required", "default", "choices", "elements", "aliases", "no_log", "version_added"):
        if opt.get(key) not in (None, False, [], ""):
            out[key] = opt[key]
    subs = opt.get("suboptions") or opt.get("options")
    if isinstance(subs, dict):
        out["suboptions"] = {k: _option(v) for k, v in subs.items() if isinstance(v, dict)}
    return out


def _returns(ret: Any) -> dict:
    if not isinstance(ret, dict):
        return {}
    out = {}
    for name, r in ret.items():
        if not isinstance(r, dict):
            continue
        item = {"type": r.get("type") or "raw", "description": text(r.get("description"))}
        if r.get("returned"):
            item["returned"] = text(r.get("returned"))
        if isinstance(r.get("contains"), dict):
            item["contains"] = _returns(r["contains"])
        out[name] = item
    return out


def _deprecated(dep: Any) -> dict | None:
    if not isinstance(dep, dict):
        return None
    return {
        "removed_in": str(
            dep.get("removed_in") or dep.get("version") or dep.get("removed_at_date") or ""
        ),
        "why": text(dep.get("why")),
        "alternative": text(dep.get("alternative") or dep.get("alternatives")),
    }


def _plugin(ptype: str, fqcn: str, entry: dict) -> dict | None:
    if ptype == "keyword":
        return {
            "type": "keyword",
            "fqcn": fqcn,
            "collection": "ansible.builtin",
            "name": fqcn,
            "short_description": text(entry.get("description")).split("\n")[0],
            "description": text(entry.get("description")),
            "applies_to": entry.get("applies_to") or [],
        }
    doc = entry.get("doc")
    if not isinstance(doc, dict):
        return None
    attributes = {}
    for name, attr in (doc.get("attributes") or {}).items():
        if isinstance(attr, dict):
            attributes[name] = {
                "support": attr.get("support"),
                "description": text(attr.get("description")),
            }
    return {
        "type": ptype,
        "fqcn": fqcn,
        "collection": doc.get("collection") or ".".join(fqcn.split(".")[:2]),
        "name": fqcn.split(".")[-1],
        "short_description": text(doc.get("short_description")),
        "description": text(doc.get("description")),
        "options": {
            k: _option(v) for k, v in (doc.get("options") or {}).items() if isinstance(v, dict)
        },
        "returns": _returns(entry.get("return")),
        "examples": entry.get("examples") if isinstance(entry.get("examples"), str) else "",
        "attributes": attributes,
        "notes": text(doc.get("notes")),
        "requirements": text(doc.get("requirements")),
        "deprecated": _deprecated(doc.get("deprecated")),
        "version_added": str(doc.get("version_added") or ""),
    }


def _routing(runtime: Any) -> dict:
    """plugin_routing of a runtime.yml: redirects, deprecations, tombstones (removed plugins)."""
    out: dict[str, dict] = {}
    if not isinstance(runtime, dict):
        return out
    for ptype, plugins in (runtime.get("plugin_routing") or {}).items():
        kind = "module" if ptype == "modules" else ptype.rstrip("s")
        for name, entry in (plugins or {}).items():
            if not isinstance(entry, dict):
                continue
            item: dict[str, Any] = {}
            if entry.get("redirect"):
                item["redirect"] = str(entry["redirect"])
            for key in ("deprecation", "tombstone"):
                if isinstance(entry.get(key), dict):
                    item[key] = {
                        "removal_version": str(
                            entry[key].get("removal_version")
                            or entry[key].get("removal_date")
                            or ""
                        ),
                        "warning_text": text(entry[key].get("warning_text")),
                    }
            if item:
                out.setdefault(kind, {})[name] = item
    return out


def _load_yaml(path: str) -> Any:
    from ansible.parsing.dataloader import DataLoader

    try:
        return DataLoader().load_from_file(path)
    except Exception:
        return None


def installed_collections() -> list[dict]:
    """Collections the environment sees, first path wins (Ansible's own precedence)."""
    exe = shutil.which("ansible-galaxy")
    cmd = [exe] if exe else [sys.executable, "-m", "ansible.cli.galaxy"]
    proc = subprocess.run(
        [*cmd, "collection", "list", "--format", "json"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    seen: dict[str, dict] = {}
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        data = {}
    for path, colls in data.items():
        for name, info in (colls or {}).items():
            if name in seen or name.startswith("ansible._"):
                continue
            seen[name] = {
                "name": name,
                "version": str((info or {}).get("version") or "0"),
                "path": os.path.join(path, *name.split(".")),
            }
    return sorted(seen.values(), key=lambda c: c["name"])


def _doc_command() -> list[str]:
    exe = shutil.which("ansible-doc")
    return [exe] if exe else [sys.executable, "-m", "ansible.cli.doc"]


def _dump(name: str, version: str, path: str | None, core: str) -> dict:
    """Dumps one collection (or ansible.builtin) and returns the normalized file content."""
    started = time.monotonic()
    proc = subprocess.run(
        [*_doc_command(), "--metadata-dump", "--no-fail-on-errors", name],
        capture_output=True,
        text=True,
        timeout=DUMP_TIMEOUT,
        check=False,
    )
    try:
        raw = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        raw = {}
    plugins = []
    for ptype, entries in (raw.get("all") or {}).items():
        if ptype not in KEPT_TYPES or not isinstance(entries, dict):
            continue
        # Keywords come with every dump; keep them once, with ansible.builtin.
        if ptype == "keyword" and name != "ansible.builtin":
            continue
        for fqcn, entry in entries.items():
            if isinstance(entry, dict):
                p = _plugin(ptype, fqcn, entry)
                if p:
                    plugins.append(p)
    if name == "ansible.builtin":
        import ansible

        runtime = _load_yaml(
            os.path.join(os.path.dirname(ansible.__file__), "config", "ansible_builtin_runtime.yml")
        )
    else:
        runtime = _load_yaml(os.path.join(path or "", "meta", "runtime.yml"))
    errors = raw.get("errors") or []
    return {
        "format": FORMAT,
        "collection": name,
        "version": version,
        "core": core,
        "plugins": plugins,
        "routing": _routing(runtime),
        "errors": [text(e if isinstance(e, str) else e.get("msg", e)) for e in errors][:50],
        "seconds": round(time.monotonic() - started, 2),
        "stderr": proc.stderr[-2000:] if proc.returncode else "",
    }


def catalog(root: str, cache: str, jobs: int = 8, only: list[str] | None = None) -> dict:
    """Dumps what is missing from `cache` and returns the manifest of this environment.

    `only` limits the manifest to these collections (a partial refresh; contract tests).
    """
    from ansible.release import __version__ as core_version

    core_minor = ".".join(core_version.split(".")[:2])
    folder = os.path.join(cache, core_minor)
    os.makedirs(folder, exist_ok=True)
    wanted = [
        {"name": "ansible.builtin", "version": core_version, "path": None},
        *installed_collections(),
    ]
    if only:
        wanted = [c for c in wanted if c["name"] in only]
    todo = []
    entries = []
    for c in wanted:
        file = f"{c['name']}@{c['version']}.json"
        entries.append({"name": c["name"], "version": c["version"], "file": f"{core_minor}/{file}"})
        if not os.path.isfile(os.path.join(folder, file)):
            todo.append((c, file))
    started = time.monotonic()

    def work(item: tuple[dict, str]) -> tuple[str, int, str | None]:
        c, file = item
        try:
            data = _dump(c["name"], c["version"], c["path"], core_version)
        except Exception as exc:  # one broken collection never stops the catalog
            return file, 0, str(exc)
        fd, tmp = tempfile.mkstemp(dir=folder, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, os.path.join(folder, file))
        return file, len(data["plugins"]), None

    results = {}
    with ThreadPoolExecutor(max_workers=max(1, min(jobs, len(todo) or 1))) as pool:
        for file, count, error in pool.map(work, todo):
            results[file] = {"plugins": count, "error": error}
    for e in entries:
        done = results.get(os.path.basename(e["file"]))
        e["dumped"] = done is not None
        if done and done["error"]:
            e["error"] = done["error"]
    return {
        "core": core_version,
        "collections": entries,
        "dumped": len(todo),
        "seconds": round(time.monotonic() - started, 2),
    }


def roles(root: str) -> list[dict]:
    """Roles of the repository (roles_path) with their argument specs (meta/argument_specs.yml)."""
    from ansible import constants as C

    found: dict[str, dict] = {}
    paths = [os.path.join(root, "roles"), *[p for p in (C.DEFAULT_ROLES_PATH or [])]]
    for base in paths:
        base = base if os.path.isabs(base) else os.path.join(root, base)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            role_dir = os.path.join(base, name)
            if name in found or not os.path.isdir(os.path.join(role_dir, "tasks")):
                continue
            spec_file = next(
                (
                    os.path.join(role_dir, "meta", f)
                    for f in ("argument_specs.yml", "argument_specs.yaml")
                    if os.path.isfile(os.path.join(role_dir, "meta", f))
                ),
                None,
            )
            specs = _load_yaml(spec_file) if spec_file else None
            entry_points = {}
            for ep, spec in ((specs or {}).get("argument_specs") or {}).items():
                if isinstance(spec, dict):
                    entry_points[ep] = {
                        "short_description": text(spec.get("short_description")),
                        "description": text(spec.get("description")),
                        "options": {
                            k: _option(v)
                            for k, v in (spec.get("options") or {}).items()
                            if isinstance(v, dict)
                        },
                    }
            tasks = sorted(
                f.rsplit(".", 1)[0]
                for f in os.listdir(os.path.join(role_dir, "tasks"))
                if f.endswith((".yml", ".yaml"))
            )
            found[name] = {
                "name": name,
                "path": os.path.relpath(role_dir, root).replace(os.sep, "/"),
                "entry_points": entry_points,
                "tasks": tasks,
            }
    return sorted(found.values(), key=lambda r: r["name"])
