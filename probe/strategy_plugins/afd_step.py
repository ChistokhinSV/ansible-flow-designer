# Ansible Flow Designer step-by-step runs (AFD-346, ADR-0039): the linear strategy that, before the
# first task of a flow step, asks the run's driver whether to go on. Stdlib only; enabled for a
# step-by-step run only, with ANSIBLE_STRATEGY=afd_step and ANSIBLE_STRATEGY_PLUGINS naming this
# folder. With it off, nothing here is loaded and a run is what it always was.
#
# The channel is two files in the run folder, the same way events.jsonl already comes back from a
# local, WSL, SSH or container run (nothing listens on a port):
# - run -> driver: pause, resume and stopped events, appended to events.jsonl (AFD_EVENTS);
# - driver -> run: control.json (AFD_STEP_CONTROL), replaced whole (write a temporary file, then
#   rename): {"v": 1, "command": "step"|"continue"|"pause"|"stop", "points": [node ids],
#   "reply": "<pause id>"|null}.
from __future__ import annotations

import json
import os
import re
import secrets
import sys
import time

from ansible.plugins.strategy.linear import StrategyModule as LinearStrategy
from ansible.utils.display import Display

DOCUMENTATION = """
    name: afd_step
    short_description: Ansible Flow Designer step-by-step runs (linear, pausing before each step)
    description:
      - The linear strategy, pausing before the first task of a flow step (a play with
        vars.flow_node_id) until the driver of the run says step, continue or stop in the file
        named by AFD_STEP_CONTROL. Pause, resume and stopped events go to the file named by
        AFD_EVENTS, beside the afd_events callback's.
      - A step's several plays (arriving hosts, the step, its route) pause once, before the first.
      - AFD_STEP_TIMEOUT (seconds, default 3600) ends a pause nobody answers; the run then stops.
      - AFD_STEP_INSIDE names the step a run starts inside (an approval's later segment): no pause
        before its first play.
    author: Ansible Flow Designer
"""

display = Display()


def _paused_line(play: str, hosts: int) -> str:
    """The terminal's line for a pause: the step's title without its [key], the hosts waiting."""
    title = re.sub(r"^\[[^\]]*\]\s*", "", play) or play
    waits = "1 host waits" if hosts == 1 else f"{hosts} hosts wait"
    return f"Paused before {title}: {waits} for Step, Continue or Stop"


VERSION = 1
POLL_S = 0.1
DEFAULT_TIMEOUT_S = 3600.0
# Pausing again: the driver's command until it changes; step and pause stop at the next step.
PAUSING = ("step", "pause")


class _State:
    """One per ansible-playbook process (kept on the task queue manager, which outlives plays)."""

    def __init__(self) -> None:
        self.control = os.environ.get("AFD_STEP_CONTROL") or ""
        events = os.environ.get("AFD_EVENTS")
        self.events = events or ""
        try:
            self.timeout = float(os.environ.get("AFD_STEP_TIMEOUT") or DEFAULT_TIMEOUT_S)
        except ValueError:
            self.timeout = DEFAULT_TIMEOUT_S
        # Pause ids name this process too: a run of approval segments is several processes.
        self.token = secrets.token_hex(4)
        self.count = 0
        # An approval's later segment starts inside the approval step (its route play): that step
        # paused already, in the segment before (AFD_STEP_INSIDE names it).
        self.last_node: str | None = os.environ.get("AFD_STEP_INSIDE") or None
        self.stopped = False
        self.good: dict = {}

    def read(self) -> dict:
        """The driver's last control.json. While it is being replaced (or a half-written one is
        read over SSH) the last whole one stands: a step boundary never runs on by mistake."""
        try:
            with open(self.control, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return self.good
        if isinstance(data, dict) and data.get("v") == VERSION:
            self.good = data
        return self.good

    def emit(self, **event: object) -> None:
        if not self.events:
            return
        event["ts"] = round(time.time(), 3)
        # Appended as one line, as the afd_events callback does (same process, same thread).
        with open(self.events, "a", encoding="utf-8") as f:
            f.write(json.dumps(event, default=str) + "\n")


def _wants_pause(control: dict, node: str) -> bool:
    if control.get("command") in PAUSING:
        return True
    points = control.get("points")
    return isinstance(points, list) and node in points


class StrategyModule(LinearStrategy):
    def _afd_state(self) -> _State:
        state = getattr(self._tqm, "_afd_step", None)
        if state is None:
            state = _State()
            self._tqm._afd_step = state
        return state

    def run(self, iterator, play_context):  # type: ignore[override]
        state = self._afd_state()
        play = iterator._play
        node = (play.vars or {}).get("flow_node_id")
        node = str(node) if node else None
        if state.stopped:
            return self._tqm.RUN_FAILED_BREAK_PLAY
        # The first play of a step only: a step's arriving and route plays go on with it.
        if node and node != state.last_node and state.control:
            self._set_hosts_cache(play)
            hosts = [h.get_name() for h in self.get_hosts_left(iterator)]
            # A play no host reaches is not where a step starts for anyone.
            if hosts:
                state.last_node = node
                if self._afd_gate(state, node, play.get_name(), hosts) == "stop":
                    state.stopped = True
                    return self._tqm.RUN_FAILED_BREAK_PLAY
        return super().run(iterator, play_context)

    def _afd_gate(self, state: _State, node: str, name: str, hosts: list[str]) -> str:
        """Pauses before `node` when the driver wants it; returns step, continue or stop."""
        control = state.read()
        if control.get("command") == "stop":
            state.emit(event="stopped", node=node, play=name, hosts=hosts, reason="driver")
            return "stop"
        if not _wants_pause(control, node):
            return "continue"
        state.count += 1
        pause = f"{state.token}-{state.count}"
        state.emit(
            event="pause",
            id=pause,
            node=node,
            play=name,
            hosts=hosts,
            timeout=state.timeout,
        )
        # AFS-205: in plain words, once: "Paused before Read facts: 2 hosts wait for Step, ...".
        display.display(_paused_line(name, len(hosts)))
        # Out now, before anyone answers: a pipe (a server's run) holds it back otherwise, and the
        # line came after who said Step.
        sys.stdout.flush()
        deadline = time.monotonic() + state.timeout
        while True:
            control = state.read()
            command = control.get("command")
            if control.get("reply") == pause and command in ("step", "continue", "stop"):
                break
            # A stop needs no reply: it may come from a driver that missed this pause.
            if command == "stop":
                break
            # AFD-347 seam: while paused, requests about this pause (variables, evaluate, set) are
            # served here, with the play, hosts and variable manager at hand. Not built (AFD-346).
            if time.monotonic() > deadline:
                state.emit(
                    event="stopped", id=pause, node=node, play=name, hosts=hosts, reason="timeout"
                )
                display.warning(
                    f"Nobody answered the pause for {int(state.timeout)} s: the run stops here"
                )
                return "stop"
            time.sleep(POLL_S)
        if command == "stop":
            state.emit(
                event="stopped", id=pause, node=node, play=name, hosts=hosts, reason="driver"
            )
            return "stop"
        state.emit(event="resume", id=pause, node=node, command=command)
        return command
