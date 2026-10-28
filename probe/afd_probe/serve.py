"""JSON-lines session: one request per stdin line, one response per stdout line.

Request:  {"id": 1, "method": "inventory", "params": {...}}
Response: {"id": 1, "result": {...}}  or  {"id": 1, "error": {"type": "...", "message": "..."}}
The first line is {"kind": "ready", ...}. A failing request never ends the session.
"""

from __future__ import annotations

import json
import os
import platform
import sys
import traceback
from collections.abc import Callable
from typing import Any, TextIO


def _prepare_environment(root: str) -> None:
    # Docker Desktop mounts are world-writable, so Ansible ignores ./ansible.cfg there; naming it
    # explicitly must happen before ansible is imported (lessons 07 §1).
    cfg = os.path.join(root, "ansible.cfg")
    if "ANSIBLE_CONFIG" not in os.environ and os.path.isfile(cfg):
        os.environ["ANSIBLE_CONFIG"] = cfg
    os.environ.setdefault("ANSIBLE_HOST_PATTERN_MISMATCH", "ignore")
    os.environ.setdefault("ANSIBLE_DEPRECATION_WARNINGS", "False")
    os.environ.setdefault("ANSIBLE_LOCALHOST_WARNING", "False")
    os.environ.setdefault("ANSIBLE_NOCOLOR", "True")


def serve(root: str, stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    root = os.path.abspath(root)
    _prepare_environment(root)
    # The protocol owns stdout: Ansible's Display and plugins print, so they get stderr.
    out = stdout or sys.stdout
    sys.stdout = sys.stderr
    os.chdir(root)

    from afd_probe import __version__, methods

    try:
        from ansible.release import __version__ as core_version
    except Exception as exc:  # no ansible-core here: say so and stop
        _write(out, {"kind": "error", "message": f"ansible-core is not importable: {exc}"})
        return 1
    try:
        from ansible.plugins.loader import init_plugin_loader

        init_plugin_loader()
    except ImportError:  # older cores initialise lazily
        pass

    _write(
        out,
        {
            "kind": "ready",
            "probe": __version__,
            "ansible_core": core_version,
            "python": platform.python_version(),
            "root": root,
        },
    )
    handlers: dict[str, Callable[..., Any]] = methods.HANDLERS
    for line in stdin or sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id: Any = None
        try:
            request = json.loads(line)
            req_id = request.get("id")
            method = request.get("method")
            handler = handlers.get(method)
            if handler is None:
                raise LookupError(f"unknown method: {method}")
            result = handler(root, **(request.get("params") or {}))
            _write(out, {"id": req_id, "result": result})
        except Exception as exc:  # report and keep serving
            traceback.print_exc(file=sys.stderr)
            _write(out, {"id": req_id, "error": {"type": type(exc).__name__, "message": str(exc)}})
    return 0


def _write(out: TextIO, message: dict[str, Any]) -> None:
    out.write(json.dumps(message, default=str) + "\n")
    out.flush()
