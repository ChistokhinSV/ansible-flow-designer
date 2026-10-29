"""Probe methods. Each takes the repository root plus keyword params and returns JSON data."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from typing import Any

PROD = re.compile(r"(^|[_.\-])(prod|production|prd|live)([_.\-0-9]|$)", re.IGNORECASE)
ORIGIN = re.compile(r"Origin: (?P<path>.+?):(?P<line>\d+)(?::(?P<col>\d+))?\s*$")
VAULT_MARKERS = ("$ANSIBLE_VAULT;", "!vault")
OUTPUT_LIMIT = 6000
SYNTAX_TIMEOUT = 120


def ping(root: str) -> dict[str, Any]:
    return {"ok": True}


def _playbook_command() -> list[str]:
    exe = shutil.which("ansible-playbook")
    return [exe] if exe else [sys.executable, "-m", "ansible.cli.playbook"]


def syntax_check(
    root: str,
    playbook: str,
    inventory: str | None = None,
    extra_vars: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`ansible-playbook --syntax-check` inside this environment (modules must exist here)."""
    cmd = [*_playbook_command(), "--syntax-check", playbook]
    if inventory:
        cmd += ["-i", inventory]
    if extra_vars:
        cmd += ["-e", json.dumps(extra_vars)]
    proc = subprocess.run(
        cmd, cwd=root, capture_output=True, text=True, timeout=SYNTAX_TIMEOUT, check=False
    )
    output = (proc.stdout + proc.stderr).strip()
    errors: list[dict[str, Any]] = []
    message: list[str] = []
    for line in output.splitlines():
        if line.startswith(("[ERROR]", "ERROR!")):
            message = [
                line.split(":", 1)[-1].strip() if line.startswith("[ERROR]") else line[6:].strip()
            ]
            continue
        match = ORIGIN.search(line)
        if match and message:
            errors.append(
                {
                    "message": " ".join(message),
                    "path": match["path"],
                    "line": int(match["line"]),
                    "column": int(match["col"] or 1),
                }
            )
            message = []
    if proc.returncode != 0 and not errors:
        errors.append({"message": output.splitlines()[-1] if output else "syntax check failed"})
    return {
        "ok": proc.returncode == 0,
        "rc": proc.returncode,
        "errors": errors,
        "output": output[-OUTPUT_LIMIT:],
    }


def inventory(
    root: str,
    inventory: str | None = None,
    targets: list[str] | None = None,
) -> dict[str, Any]:
    """Hosts the flow's targets resolve to, their groups, and what looks like production."""
    from ansible import constants as C
    from ansible.inventory.manager import InventoryManager
    from ansible.parsing.dataloader import DataLoader

    sources = [inventory] if inventory else C.DEFAULT_HOST_LIST
    inv = InventoryManager(loader=DataLoader(), sources=sources)
    names = [str(t) for t in (targets or []) if str(t).strip()]
    hosts = inv.get_hosts(",".join(names)) if names else []
    unknown = [n for n in names if not inv.get_hosts(n)]
    groups: dict[str, int] = {}
    for host in hosts:
        for group in host.get_groups():
            if group.name not in ("all", "ungrouped"):
                groups[group.name] = groups.get(group.name, 0) + 1
    source_list = sources if isinstance(sources, list) else [sources]
    return {
        "sources": [str(s) for s in source_list],
        "count": len(hosts),
        "hosts": [h.name for h in hosts[:50]],
        "unknown": unknown,
        "groups": dict(sorted(groups.items())),
        "prod_groups": sorted(g for g in groups if PROD.search(g)),
        "prod_hosts": sorted(h.name for h in hosts if PROD.search(h.name))[:50],
        "vault": _vault_present(root, source_list),
    }


def _vault_present(root: str, sources: list[Any]) -> bool:
    """Vault-encrypted files or inline !vault values near the inventory or in the repo vars."""
    places = [os.path.join(root, "group_vars"), os.path.join(root, "host_vars")]
    for source in sources:
        path = os.path.join(root, str(source)) if not os.path.isabs(str(source)) else str(source)
        places.append(path if os.path.isdir(path) else os.path.dirname(path))
    seen: set[str] = set()
    for place in places:
        if not os.path.isdir(place) or place in seen:
            continue
        seen.add(place)
        for folder, _dirs, files in os.walk(place):
            for name in files:
                try:
                    with open(os.path.join(folder, name), encoding="utf-8", errors="ignore") as fh:
                        head = fh.read(65536)
                except OSError:
                    continue
                if any(marker in head for marker in VAULT_MARKERS):
                    return True
    return False


def catalog(root: str, cache: str, jobs: int = 8, only: list[str] | None = None) -> dict[str, Any]:
    """Dumps the environment's plugin docs into `cache` (M5); see catalog.py."""
    from afd_probe import catalog as cat

    return cat.catalog(root, cache, jobs, only)


def roles(root: str) -> list[dict[str, Any]]:
    """The repository's roles with their argument specs (M5)."""
    from afd_probe import catalog as cat

    return cat.roles(root)


def compile(  # noqa: A001 - the protocol method name
    root: str,
    playbooks: list[str] | None = None,
    roles: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Plays and tasks Ansible compiles from playbooks and bound roles (M6); see code.py."""
    from afd_probe import code

    return code.compile_code(root, playbooks, roles)


HANDLERS = {
    "ping": ping,
    "syntax_check": syntax_check,
    "inventory": inventory,
    "catalog": catalog,
    "roles": roles,
    "compile": compile,
}
