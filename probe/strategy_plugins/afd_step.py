# Ansible Flow Designer step-by-step runs (AFD-346, ADR-0039): the linear strategy that, before the
# first task of a flow step, asks the run's driver whether to go on. Stdlib only; enabled for a
# step-by-step run only, with ANSIBLE_STRATEGY=afd_step and ANSIBLE_STRATEGY_PLUGINS naming this
# folder. With it off, nothing here is loaded and a run is what it always was.
#
# The channel is two files in the run folder, the same way events.jsonl already comes back from a
# local, WSL, SSH or container run (nothing listens on a port):
# - run -> driver: pause, resume and stopped events, appended to events.jsonl (AFD_EVENTS);
# - driver -> run: control.json (AFD_STEP_CONTROL), replaced whole (write a temporary file, then
#   rename): {"v": 1, "command": "step"|"continue"|"pause"|"stop"|"retry", "points": [node ids or
#   {node, condition?, hits?, log?}], "reply": "<pause id>"|null, "after"?, "failures"?, "hits"?}.
#
# Debug runs (AFD_DEBUG=1, ADR-0040) add, from probe/afd_lib (loaded only then):
# - requests answered while paused (request-<n>.json -> answer-<n>.json beside control.json);
# - pause points with a condition, a hit count or a log message;
# - a pause after a step's play when hosts failed it (kind failure), with Retry.
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
      - AFD_DEBUG=1 makes it a debug run (ADR-0040): variables, evaluate and watch while paused,
        pause points with a condition, a hit count or a log message, and a pause on failure with
        Retry.
    author: Ansible Flow Designer
"""

display = Display()


def _paused_line(play: str, hosts: int) -> str:
    """The terminal's line for a pause: the step's title without its [key], the hosts waiting."""
    title = re.sub(r"^\[[^\]]*\]\s*", "", play) or play
    waits = "1 host waits" if hosts == 1 else f"{hosts} hosts wait"
    return f"Paused before {title}: {waits} for Step, Continue or Stop"


def _failed_line(play: str, failed: int, hosts: int, attempt: int) -> str:
    title = re.sub(r"^\[[^\]]*\]\s*", "", play) or play
    of = f"{failed} of {hosts} hosts" if hosts > 1 else "1 host"
    return f"Paused after {title}: {of} failed (attempt {attempt}): Retry, Continue or Stop"


def _log_line(play: str, event: dict) -> str | None:
    """A log point's line in the run's output (ADR-0040 §6): masked as the event is."""
    title = re.sub(r"^\[[^\]]*\]\s*", "", play) or play
    host = event.get("host")
    where = f"{title} · {host}" if host else title
    if "message" in event:
        return f"Log point {where}: {event['message']}"[:2000]
    if event.get("error"):
        what = {"condition": "condition", "log": "log message"}.get(event.get("source"), "point")
        return f"Log point {where}: the {what} failed: {event['error']}"[:2000]
    return None


VERSION = 1
POLL_S = 0.1
DEFAULT_TIMEOUT_S = 3600.0
# Pausing again: the driver's command until it changes; step and pause stop at the next step.
PAUSING = ("step", "pause")
ANSWERS = ("step", "continue", "stop")
# The generator's failure facts (optionA FAILURE_FACTS) and Ansible's own in a rescue.
FAIL_FACTS = (
    "afd_failed_result",
    "afd_failed_task",
    "afd_failed_node",
    "ansible_failed_result",
    "ansible_failed_task",
)
# A rolling subflow (AFD-55) is one play with serial for all its steps.
ROLLING = re.compile(r": rolling, .+ at a time$")
NO_RETRY_ROLLING = (
    "Retry is not offered in a rolling subflow: its steps run as one play for each batch. "
    "Rerun from this step as a new run instead."
)
NO_RETRY_HARD = (
    "Retry is not offered for a host that failed outside the step's rescue (a failure "
    "percentage, an include error). Rerun from this step as a new run instead."
)
_MISSING = object()


def _debug_lib():
    """probe/afd_lib, beside this folder: loaded in debug runs only."""
    probe = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if probe not in sys.path:
        sys.path.insert(0, probe)
    from afd_lib import debug  # noqa: PLC0415

    return debug


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
        # ADR-0040: a debug run; the library and its session, or why there is none.
        self.debug_on = os.environ.get("AFD_DEBUG") == "1" and bool(self.control)
        self.debug = None
        self.no_debug: str | None = None
        if self.debug_on:
            try:
                lib = _debug_lib()
                self.no_debug = lib.unavailable()
                if not self.no_debug:
                    self.debug = lib.Session()
                    # Hit counts carried by the driver from an approval's earlier segments.
                    hits = self.read().get("hits")
                    if isinstance(hits, dict):
                        for k, v in hits.items():
                            if isinstance(v, int) and not isinstance(v, bool):
                                self.debug.hits[str(k)] = v
            except Exception as ex:  # noqa: BLE001 - the run goes on step by step
                self.no_debug = f"The debugger could not start: {type(ex).__name__}: {ex}"[:300]
        self.lib = sys.modules.get("afd_lib.debug") if self.debug else None

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

    def failures(self) -> dict:
        """Which failures pause a debug run: a host failed (on by default), unreachable."""
        f = self.read().get("failures")
        f = f if isinstance(f, dict) else {}
        return {
            "failed": f.get("failed", True) is not False,
            "unreachable": f.get("unreachable") is True,
        }


def _points(control: dict) -> dict[str, dict]:
    """The pause points by node: a bare id, or {node, condition?, hits?, log?}."""
    out: dict[str, dict] = {}
    points = control.get("points")
    for p in points if isinstance(points, list) else []:
        if isinstance(p, str):
            out[p] = {"node": p}
        elif isinstance(p, dict) and isinstance(p.get("node"), str):
            out[p["node"]] = p
    return out


def _settings(point: dict) -> bool:
    return any(point.get(k) not in (None, "", 0) for k in ("condition", "hits", "log"))


def _stepping(control: dict) -> bool:
    command = control.get("command")
    # After Retry the run goes on as the driver went before it (`after`: step or continue).
    return command in PAUSING or (command == "retry" and control.get("after") in PAUSING)


def _wants_pause(control: dict, node: str) -> bool:
    """Outside a debug run: point settings are not read; a log-only point never pauses."""
    if _stepping(control):
        return True
    point = _points(control).get(node)
    if point is None:
        return False
    return not (point.get("log") and not point.get("condition") and not point.get("hits"))


def _msg(result: object) -> str:
    if not isinstance(result, dict):
        return ""
    parts = [str(result.get("msg") or result.get("reason") or "")]
    rc = result.get("rc")
    if rc not in (None, 0):
        parts.append(f"rc={rc}")
    err = result.get("stderr")
    if err:
        parts.append(str(err)[:200])
    return "; ".join(p for p in parts if p)[:500]


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
        if state.debug is not None:
            state.debug.note_play(play)
        # The first play of a step only: a step's arriving and route plays go on with it.
        if node and node != state.last_node and state.control:
            self._set_hosts_cache(play)
            hosts = list(self.get_hosts_left(iterator))
            # A play no host reaches is not where a step starts for anyone.
            if hosts:
                state.last_node = node
                if self._afd_gate(state, node, play, hosts) == "stop":
                    state.stopped = True
                    return self._tqm.RUN_FAILED_BREAK_PLAY
        if node and state.debug is not None:
            return self._afd_run_watching(state, node, iterator, play_context)
        return super().run(iterator, play_context)

    # ---- the step gate ---------------------------------------------------------------------
    def _afd_gate(self, state: _State, node: str, play, hosts: list) -> str:
        """Pauses before `node` when the driver wants it; returns step, continue or stop."""
        name = play.get_name()
        names = [h.get_name() for h in hosts]
        control = state.read()
        if control.get("command") == "stop":
            state.emit(event="stopped", node=node, play=name, hosts=names, reason="driver")
            return "stop"
        if state.debug is None:
            if not _wants_pause(control, node):
                return "continue"
            return self._afd_pause(
                state, node, play, hosts, "step" if _stepping(control) else "point"
            )
        kind = "step" if _stepping(control) else None
        extra: dict = {}
        point = _points(control).get(node)
        if point is not None and _settings(point):
            found = state.lib.at_point(state.debug, self, play, hosts, node, point)
            for e in found["events"]:
                state.emit(**e)
                if e.get("event") == "log":
                    line = _log_line(name, e)
                    if line:
                        display.display(line)
            if found["pause"]:
                kind = "condition" if point.get("condition") or point.get("hits") else "point"
                if found["matched"]:
                    extra["matched"] = found["matched"]
                if point.get("hits"):
                    extra["reached"] = point.get("hits")
        elif point is not None:
            kind = "point"
        if kind is None:
            return "continue"
        return self._afd_pause(state, node, play, hosts, kind, **extra)

    def _afd_pause(self, state: _State, node: str, play, hosts: list, kind: str, **extra) -> str:
        """Waits at a pause for the driver's answer, serving debugger requests meanwhile."""
        name = play.get_name()
        names = [h.get_name() for h in hosts]
        state.count += 1
        pause = f"{state.token}-{state.count}"
        refused = extra.pop("refused", None)
        event: dict = {
            "event": "pause",
            "id": pause,
            "node": node,
            "play": name,
            "hosts": names,
            "timeout": state.timeout,
        }
        if state.debug_on:
            event["kind"] = kind
            event.update(extra)
            if refused:
                event["retry"] = {"refused": refused}
            if state.debug is not None:
                event["debug"] = True
            elif state.no_debug:
                event["debug"] = False
                event["why"] = state.no_debug
        state.emit(**event)
        if kind == "failure":
            failed = extra.get("failed") or []
            display.display(_failed_line(name, len(failed), len(names), extra.get("attempt", 1)))
            for f in failed:
                display.display(f"  {f['host']}: {f.get('task') or ''}: {f.get('msg') or ''}"[:300])
        else:
            # AFS-205: in plain words, once: "Paused before Read facts: 2 hosts wait for Step, ...".
            display.display(_paused_line(name, len(names)))
        # Out now, before anyone answers: a pipe (a server's run) holds it back otherwise, and the
        # line came after who said Step.
        sys.stdout.flush()
        gate = state.debug.gate(self, play, hosts, pause) if state.debug is not None else None
        folder = os.path.dirname(state.control) or "."
        answers = (*ANSWERS, "retry") if kind == "failure" else ANSWERS
        told = False
        deadline = time.monotonic() + state.timeout
        while True:
            control = state.read()
            command = control.get("command")
            if control.get("reply") == pause and command in answers:
                if command == "retry" and refused:
                    if not told:
                        state.emit(
                            event="refused", id=pause, node=node, command="retry", why=refused
                        )
                        told = True
                else:
                    break
            # A stop needs no reply: it may come from a driver that missed this pause.
            if command == "stop":
                break
            # ADR-0040: while paused, requests about this pause are answered here, with the play,
            # its hosts and the variable manager at hand.
            if gate is not None:
                gate.serve(folder)
            if time.monotonic() > deadline:
                state.emit(
                    event="stopped", id=pause, node=node, play=name, hosts=names, reason="timeout"
                )
                display.warning(
                    f"Nobody answered the pause for {int(state.timeout)} s: the run stops here"
                )
                return "stop"
            time.sleep(POLL_S)
        if command == "stop":
            stopped: dict = {"hosts": names}
            if kind == "failure":
                # Stopped after the step: its failed hosts stay failed there, the others ran it
                # and stop after it (not before it).
                gone = {f["host"] for f in extra.get("failed") or []}
                stopped = {
                    "hosts": [n for n in names if n not in gone],
                    "failed": [n for n in names if n in gone],
                    "after": True,
                }
            state.emit(event="stopped", id=pause, node=node, play=name, reason="driver", **stopped)
            return "stop"
        state.emit(event="resume", id=pause, node=node, command=command)
        return command

    # ---- pause on failure, Retry (ADR-0040 §7) ---------------------------------------------
    def _afd_snapshot(self, play) -> dict:
        hosts = self._inventory.get_hosts(play.hosts, order=play.order)
        facts = self._variable_manager._nonpersistent_fact_cache
        stats = self._tqm._stats
        return {
            h.name: {
                "host": h,
                "groups": {g.name for g in h.groups},
                "rescued": stats.rescued.get(h.name, 0),
                "dark": stats.dark.get(h.name, 0),
                "failures": stats.failures.get(h.name, 0),
                "unreachable": h.name in self._tqm._unreachable_hosts,
                "hard": h.name in self._tqm._failed_hosts,
                "facts": {k: facts.get(h.name, {}).get(k, _MISSING) for k in FAIL_FACTS},
            }
            for h in hosts
        }

    def _afd_failed(self, before: dict, filters: dict) -> list[dict]:
        """The hosts that failed the play just run: rescued into the fail port (the rescue set
        afd_failed_node again), failed outside the rescue, or unreachable (when asked)."""
        facts = self._variable_manager._nonpersistent_fact_cache
        stats = self._tqm._stats
        out = []
        for name, snap in before.items():
            hf = facts.get(name, {})
            node_fact = hf.get("afd_failed_node", _MISSING)
            rescued = (
                stats.rescued.get(name, 0) > snap["rescued"]
                and node_fact is not _MISSING
                and node_fact is not snap["facts"]["afd_failed_node"]
            )
            hard = name in self._tqm._failed_hosts and not snap["hard"]
            # A module step ignores unreachable and routes the host to its unreachable port
            # (flow_<key>_unreachable); a role step leaves it unreachable in Ansible's terms.
            added = {g.name for g in snap["host"].groups} - snap["groups"]
            gone = (
                (name in self._tqm._unreachable_hosts and not snap["unreachable"])
                or stats.dark.get(name, 0) > snap["dark"]
                or any(g.endswith("_unreachable") for g in added)
            )
            if filters["failed"] and (rescued or hard):
                item = {
                    "host": name,
                    "task": str(hf.get("afd_failed_task") or ""),
                    "msg": _msg(hf.get("afd_failed_result")),
                }
                if hard and not rescued:
                    item["hard"] = True
                out.append(item)
            elif filters["unreachable"] and gone:
                out.append({"host": name, "task": "", "msg": "Unreachable", "unreachable": True})
        return out

    def _afd_undo(self, before: dict, names: list[str]) -> dict:
        """Takes back what the failed attempt did to these hosts; returns the groups undone."""
        inv = self._inventory
        facts = self._variable_manager._nonpersistent_fact_cache
        stats = self._tqm._stats
        undone = {}
        for name in names:
            snap = before[name]
            host = snap["host"]
            added = sorted({g.name for g in host.groups} - snap["groups"])
            for g in added:
                inv.groups[g].remove_host(host)
            hf = facts.get(name, {})
            for k, v in snap["facts"].items():
                if v is _MISSING:
                    hf.pop(k, None)
                else:
                    hf[k] = v
            for stat in ("rescued", "dark", "failures"):
                table = getattr(stats, stat)
                if snap[stat]:
                    table[name] = snap[stat]
                else:
                    table.pop(name, None)
            if not snap["hard"]:
                self._tqm._failed_hosts.pop(name, None)
            if not snap["unreachable"]:
                self._tqm._unreachable_hosts.pop(name, None)
            undone[name] = added
        # Group patterns (the next plays' hosts: flow_x_ok_hosts) are cached by the inventory.
        inv.clear_pattern_cache()
        return undone

    def _afd_rerun(self, iterator, play_context, names: list[str]):
        """The same play again, on a fresh iterator restricted to these hosts (linear's run: no
        step pause before it)."""
        from ansible.executor.play_iterator import PlayIterator

        inv = self._inventory
        play = iterator._play
        saved = inv._restriction
        try:
            inv.restrict_to_hosts([inv.get_host(n) for n in names])
            for n in names:
                if n in play._removed_hosts:
                    play._removed_hosts.remove(n)
            again = PlayIterator(
                inventory=inv,
                play=play,
                play_context=play_context,
                variable_manager=self._variable_manager,
                all_vars=self._variable_manager.get_vars(play=play),
                start_at_done=False,
            )
            return LinearStrategy.run(self, again, play_context)
        finally:
            inv._restriction = saved
            inv.clear_pattern_cache()
            self._set_hosts_cache(play, refresh=True)

    def _afd_run_watching(self, state: _State, node: str, iterator, play_context):
        """Runs the step's play; when hosts failed it, pauses (kind failure) for Retry, Continue
        or Stop. A second failure pauses again."""
        play = iterator._play
        filters = state.failures()
        if (
            not (filters["failed"] or filters["unreachable"])
            or state.read().get("command") == "stop"
        ):
            return super().run(iterator, play_context)
        before = self._afd_snapshot(play)
        # Every pause holds all hosts: after a Retry, those that passed still wait at it.
        everyone = [s["host"] for s in before.values()]
        result = super().run(iterator, play_context)
        attempt = 1
        while not state.stopped:
            filters = state.failures()
            failed = self._afd_failed(before, filters)
            if not failed or state.read().get("command") == "stop":
                return result
            refused = None
            if ROLLING.search(play.get_name()) and play.serial:
                refused = NO_RETRY_ROLLING
            elif any(f.get("hard") for f in failed):
                refused = NO_RETRY_HARD
            command = self._afd_pause(
                state,
                node,
                play,
                everyone,
                "failure",
                failed=failed,
                attempt=attempt,
                refused=refused,
            )
            if command == "stop":
                state.stopped = True
                return self._tqm.RUN_FAILED_BREAK_PLAY
            if command != "retry":
                return result  # step or continue: the failed hosts go on by their fail port
            names = [f["host"] for f in failed]
            undone = self._afd_undo(before, names)
            attempt += 1
            state.emit(
                event="retry",
                node=node,
                play=play.get_name(),
                attempt=attempt,
                hosts=names,
                undone=undone,
            )
            fresh = self._afd_snapshot(play)
            before = {n: fresh.get(n, before[n]) for n in names}
            result = self._afd_rerun(iterator, play_context, names)
        return self._tqm.RUN_FAILED_BREAK_PLAY
