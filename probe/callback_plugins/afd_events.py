# Ansible Flow Designer run events: one JSON object per line in the file named by AFD_EVENTS.
# Stdlib only; enabled with ANSIBLE_CALLBACKS_ENABLED=afd_events next to the normal stdout callback.
from __future__ import annotations

import json
import os
import time

from ansible.plugins.callback import CallbackBase

DOCUMENTATION = """
    name: afd_events
    type: notification
    short_description: Ansible Flow Designer run events (JSON lines)
    description:
      - Writes play starts, task results with routing groups, and final stats to the file named
        by the AFD_EVENTS environment variable, so the designer can map a run back to flow nodes.
      - Task results also carry changed, rc and the task's output (stdout, stderr, msg; cut), read
        while the run goes and shown per host (AFD-81). A no_log result says only censored.
    requirements: []
"""

MSG_LIMIT = 500
OUT_LIMIT = 2000
# The generated routing tasks: their results are the routes, not output worth showing.
ROUTING = {
    "add_host",
    "group_by",
    "meta",
    "ansible.builtin.add_host",
    "ansible.builtin.group_by",
    "ansible.builtin.meta",
}


REDACTED = "********"


def _leaves(value: object, out: set[str]) -> None:
    """Every string and number inside a secret input (AFD-139): a list or dict secret is matched
    by its parts, since tasks print those, not the whole JSON."""
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (str, int, float)):
        text = str(value)
        if text:
            out.add(text)
    elif isinstance(value, dict):
        out.add(json.dumps(value, separators=(",", ":")))
        for v in value.values():
            _leaves(v, out)
    elif isinstance(value, list):
        out.add(json.dumps(value, separators=(",", ":")))
        for v in value:
            _leaves(v, out)


def _secrets() -> list[str]:
    """The run's secret values, from the files the run's shell names (AFD-139): the secret
    inputs (AFD_SECRETS_FILE, JSON) and the vault password (AFD_VAULT_FILE). Longest first, so a
    secret that contains another is replaced whole."""
    found: set[str] = set()
    path = os.environ.get("AFD_SECRETS_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            for v in data.values() if isinstance(data, dict) else []:
                _leaves(v, found)
        except (OSError, ValueError):
            pass
    path = os.environ.get("AFD_VAULT_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                password = f.read().rstrip("\r\n")
            if password:
                found.add(password)
        except OSError:
            pass
    return sorted(found, key=len, reverse=True)


def _scrub(value: object, secrets: list[str]) -> object:
    if isinstance(value, str):
        for s in secrets:
            if s in value:
                value = value.replace(s, REDACTED)
        return value
    if isinstance(value, list):
        return [_scrub(v, secrets) for v in value]
    if isinstance(value, dict):
        return {k: _scrub(v, secrets) for k, v in value.items()}
    return value


def _text(value: object) -> str | None:
    """Output as text, cut at OUT_LIMIT; None when empty."""
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, list):
        value = "\n".join(str(v) for v in value)
    elif not isinstance(value, str):
        value = json.dumps(value, default=str)
    return value[:OUT_LIMIT]


class CallbackModule(CallbackBase):
    CALLBACK_VERSION = 2.0
    CALLBACK_TYPE = "notification"
    CALLBACK_NAME = "afd_events"
    CALLBACK_NEEDS_ENABLED = True

    def __init__(self) -> None:
        super().__init__()
        path = os.environ.get("AFD_EVENTS")
        self._out = open(path, "a", encoding="utf-8") if path else None  # noqa: SIM115
        self._node: str | None = None
        # AFD-139: secret values never reach the file, also when the run stops before the
        # extension's own redaction pass at its end.
        self._secrets = _secrets()

    def _emit(self, **event: object) -> None:
        if self._out is None:
            return
        event["ts"] = round(time.time(), 3)
        if self._secrets:
            event = _scrub(json.loads(json.dumps(event, default=str)), self._secrets)
        self._out.write(json.dumps(event, default=str) + "\n")
        self._out.flush()

    def v2_playbook_on_start(self, playbook) -> None:
        self._emit(event="start", playbook=os.path.basename(playbook._file_name))

    def v2_playbook_on_play_start(self, play) -> None:
        node = (play.vars or {}).get("flow_node_id")
        self._node = str(node) if node else None
        self._emit(event="play", name=play.get_name(), node=self._node)

    def _result(self, status: str, result, **extra: object) -> None:
        data = result._result
        event: dict[str, object] = {
            "event": "result",
            "status": status,
            "host": result._host.get_name(),
            "task": result._task.get_name(),
            "action": result._task.action,
            "node": self._node,
        }
        if data.get("add_group"):
            event["group"] = data["add_group"]
        added = data.get("add_host")
        if isinstance(added, dict):
            event["added"] = {"host": added.get("host_name"), "groups": added.get("groups")}
        if "censored" in data or data.get("_ansible_no_log"):
            event["censored"] = True
            event.update(extra)
            self._emit(**event)
            return
        message = data.get("msg") or data.get("reason")
        if status in ("failed", "unreachable") and message:
            event["msg"] = str(message)[:MSG_LIMIT]
        routing = "group" in event or "added" in event or result._task.action in ROUTING
        if not routing:
            if "changed" in data:
                event["changed"] = bool(data["changed"])
            if isinstance(data.get("rc"), int):
                event["rc"] = data["rc"]
            out = {k: t for k in ("stdout", "stderr", "msg") if (t := _text(data.get(k)))}
            if out:
                event["out"] = out
        event.update(extra)
        self._emit(**event)

    def v2_runner_on_ok(self, result) -> None:
        self._result("ok", result)

    def v2_runner_on_failed(self, result, ignore_errors: bool = False) -> None:
        self._result("failed", result, ignored=ignore_errors)

    def v2_runner_on_unreachable(self, result) -> None:
        self._result("unreachable", result)

    def v2_runner_on_skipped(self, result) -> None:
        self._result("skipped", result)

    def v2_runner_item_on_ok(self, result) -> None:
        self._result("ok", result, item=True)

    def v2_playbook_on_stats(self, stats) -> None:
        hosts = sorted(stats.processed.keys())
        # set_stats data (per_host: false): what an AWX workflow passes to the next segment.
        custom = (getattr(stats, "custom", None) or {}).get("_run")
        extra = {"custom": custom} if custom else {}
        self._emit(event="stats", hosts={h: stats.summarize(h) for h in hosts}, **extra)
        if self._out is not None:
            self._out.close()
            self._out = None
