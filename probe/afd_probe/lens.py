"""Inventory lens (M8): host patterns counted against the inventory, the variables that decide
access per pattern with their origin, and the names of vaulted variables.

Vaulted values are never decrypted: ansible-core 2.19+ keeps them as ``EncryptedString`` until
something reads them, and this module only checks their type. Origins come from the data tags
ansible-core 2.19+ attaches to strings and numbers (booleans and nulls carry none).
"""

from __future__ import annotations

import os
from typing import Any

ACCESS_VARS = ("ansible_user", "ansible_become", "ansible_become_user", "ansible_connection")
HOST_LIMIT = 5000
SAMPLE = 3
ORIGINS = 5
STATIC_SUFFIXES = (".ini", ".cfg", ".yml", ".yaml", ".json", ".toml")


def _encrypted_types() -> tuple[type, ...]:
    found: list[type] = []
    try:
        from ansible.parsing.vault import EncryptedString

        found.append(EncryptedString)
    except ImportError:
        pass
    try:
        from ansible.parsing.yaml.objects import AnsibleVaultEncryptedUnicode

        found.append(AnsibleVaultEncryptedUnicode)
    except ImportError:
        pass
    return tuple(found)


def _origin_of(root: str):
    try:
        from ansible._internal._datatag._tags import Origin
    except ImportError:
        return lambda _value: None

    def origin(value: Any) -> str | None:
        tag = Origin.get_tag(value)
        if tag is None or not tag.path:
            return None
        path = tag.path
        if os.path.isabs(path) and path.startswith(root + os.sep):
            path = os.path.relpath(path, root)
        return f"{path}:{tag.line_num}" if tag.line_num else path

    return origin


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _dynamic(root: str, sources: list[str]) -> list[str]:
    """Sources that run code to produce hosts: inventory plugin configs and scripts."""
    out: list[str] = []
    for source in sources:
        path = source if os.path.isabs(source) else os.path.join(root, source)
        files = (
            [os.path.join(path, f) for f in sorted(os.listdir(path))]
            if os.path.isdir(path)
            else [path]
        )
        for f in files:
            if not os.path.isfile(f):
                continue
            name = os.path.relpath(f, root) if f.startswith(root + os.sep) else f
            if f.endswith((".yml", ".yaml")):
                try:
                    with open(f, encoding="utf-8", errors="ignore") as fh:
                        head = fh.read(4096)
                except OSError:
                    continue
                if any(line.startswith("plugin:") for line in head.splitlines()):
                    out.append(name)
            elif not f.endswith(STATIC_SUFFIXES) and os.access(f, os.X_OK):
                out.append(name)
    return out


def inventory_lens(
    root: str,
    inventory: str | None = None,
    targets: str = "",
    patterns: list[str] | None = None,
) -> dict[str, Any]:
    from ansible import constants as C
    from ansible.inventory.manager import InventoryManager
    from ansible.parsing.dataloader import DataLoader
    from ansible.vars.manager import VariableManager

    from afd_probe.methods import PROD

    loader = DataLoader()
    sources = [inventory] if inventory else C.DEFAULT_HOST_LIST
    source_list = [str(s) for s in (sources if isinstance(sources, list) else [sources])]
    inv = InventoryManager(loader=loader, sources=source_list)
    variables = VariableManager(loader=loader, inventory=inv)
    encrypted = _encrypted_types()
    origin = _origin_of(os.path.abspath(root))

    target_names = {h.name for h in inv.get_hosts(targets)} if targets.strip() else set()
    resolved: dict[str, list[Any]] = {}
    out_patterns: dict[str, dict[str, Any]] = {}
    scope: dict[str, Any] = {}
    for pattern in patterns or []:
        hosts = inv.get_hosts(pattern)
        resolved[pattern] = hosts
        outside = [h.name for h in hosts if h.name not in target_names]
        out_patterns[pattern] = {
            "count": len(hosts),
            "outside": len(outside),
            "sample": outside[:SAMPLE],
        }
        for h in hosts:
            scope.setdefault(h.name, h)

    groups: dict[str, int] = {}
    for h in scope.values():
        for g in h.get_groups():
            if g.name not in ("all", "ungrouped"):
                groups[g.name] = groups.get(g.name, 0) + 1

    # Per host: the access variables (value, origin, vaulted), and every vaulted variable's name.
    per_host: dict[str, dict[str, tuple[str | None, str | None, bool]]] = {}
    vaulted: dict[str, str] = {}
    for name, host in list(scope.items())[:HOST_LIMIT]:
        hv = variables.get_vars(host=host, include_hostvars=False, stage="task")
        picked: dict[str, tuple[str | None, str | None, bool]] = {}
        for key, value in hv.items():
            secret = bool(encrypted) and isinstance(value, encrypted)
            if secret and key not in vaulted:
                vaulted[key] = origin(value) or "inventory"
            if key in ACCESS_VARS:
                picked[key] = (None if secret else _text(value), origin(value), secret)
        per_host[name] = picked

    access: dict[str, dict[str, Any]] = {}
    for pattern, hosts in resolved.items():
        agg: dict[str, Any] = {}
        for h in hosts:
            for key, (value, where, secret) in per_host.get(h.name, {}).items():
                entry = agg.setdefault(key, {"values": {}, "origins": []})
                if secret:
                    entry["vault"] = True
                    continue
                entry["values"][value] = entry["values"].get(value, 0) + 1
                if where and where not in entry["origins"] and len(entry["origins"]) < ORIGINS:
                    entry["origins"].append(where)
        access[pattern] = agg

    return {
        "sources": source_list,
        "dynamic": _dynamic(os.path.abspath(root), source_list),
        "total": len(inv.get_hosts("all")),
        "targets": targets,
        "patterns": out_patterns,
        "scope": {"count": len(scope), "groups": dict(sorted(groups.items()))},
        "prod_groups": sorted(g for g in groups if PROD.search(g)),
        "access": access,
        "vaulted": dict(sorted(vaulted.items())),
    }
