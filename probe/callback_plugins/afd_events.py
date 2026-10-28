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
    requirements: []
"""

MSG_LIMIT = 500


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

    def _emit(self, **event: object) -> None:
        if self._out is None:
            return
        event["ts"] = round(time.time(), 3)
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
        message = data.get("msg") or data.get("reason")
        if status in ("failed", "unreachable") and message:
            event["msg"] = str(message)[:MSG_LIMIT]
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
        self._emit(event="stats", hosts={h: stats.summarize(h) for h in hosts})
        if self._out is not None:
            self._out.close()
            self._out = None
