# The debugger at a pause (ADR-0040 §2, §3, §5, §6; AFD-370, AFD-371): requests served from the
# afd_step gate loop, and pause point conditions, hit counts and log points at a step gate.
#
# Channel: the driver writes request-<n>.json beside control.json (whole: a temporary file, then a
# rename): {v:1, pause, n, op, host?, hosts?, scope?, path?, start?, count?, expr?, exprs?,
# timeout?}. The gate loop answers with answer-<n>.json (whole too) on its 100 ms tick and removes
# the request. A request for a pause that is not the current one is answered {gone: true}.
# Ops: scopes, vars, facts, eval, watch.
from __future__ import annotations

import json
import os
import time
from collections.abc import Mapping

from . import capture, render
from .capture import HostView, entry, plain, to_json
from .mask import TAGS, Masker

VERSION = 1
# A gate's conditions and log messages, for every host: one child, at most this long.
GATE_LIMIT = 2.0


def unavailable() -> str | None:
    """Why this core cannot be debugged, in words; None when it can."""
    if not TAGS:
        return "Debugging needs ansible-core 2.19 or later; this run goes on step by step only"
    try:
        import ansible._internal._templating._jinja_plugins as jp

        if not hasattr(jp, "lookup_loader"):
            raise ImportError
    except ImportError:
        return (
            "This ansible-core cannot block lookups while debugging; the run goes on step by step"
        )
    return None


def write_whole(path: str, data: object) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str))
    os.replace(tmp, path)


class Session:
    """One per ansible-playbook process: the masker (its known values grow) and hit counts."""

    def __init__(self) -> None:
        self.masker = Masker()
        self.hits: dict[str, int] = {}
        # Registers of no_log tasks, from every play so far (ADR-0040 §4, check 4).
        self.nolog: set[str] = set()

    def note_play(self, play) -> None:
        self.nolog |= capture.nolog_registers(play)

    def gate(self, strategy, play, hosts: list, pause: str) -> Gate:
        return Gate(self, strategy, play, hosts, pause)


class Gate:
    """One pause: the play, its hosts and the variable manager, with each host's view cached."""

    def __init__(self, session: Session, strategy, play, hosts: list, pause: str) -> None:
        self.session = session
        self.strategy = strategy
        self.play = play
        self.hosts = {h.get_name(): h for h in hosts}
        self.pause = pause
        self._views: dict[str, HostView] = {}
        self._secret: set[str] | None = None
        self._templar = None

    # ---- what a host has -------------------------------------------------------------------
    def variables(self, host) -> Mapping:
        s = self.strategy
        return s._variable_manager.get_vars(  # noqa: SLF001
            play=self.play,
            host=host,
            _hosts=getattr(s, "_hosts_cache", None),
            _hosts_all=getattr(s, "_hosts_cache_all", None),
        )

    def view(self, name: str) -> HostView:
        if name not in self._views:
            if self._secret is None:
                self._secret = capture.secret_inputs(self.play)
            vm = self.strategy._variable_manager  # noqa: SLF001
            self._views[name] = HostView(
                self.variables(self.hosts[name]),
                play_vars=set(self.play.vars or {}),
                extra=set(vm.extra_vars or {}),
                secret=self._secret,
                masker=self.session.masker,
                nolog=self.session.nolog,
            )
        return self._views[name]

    def environment(self):
        if self._templar is None:
            from ansible.template import Templar

            self._templar = Templar(loader=self.strategy._loader)  # noqa: SLF001
        return self._templar.environment

    # ---- requests --------------------------------------------------------------------------
    def serve(self, folder: str) -> int:
        """Answers the request files waiting in `folder`; returns how many."""
        try:
            names = sorted(
                n for n in os.listdir(folder) if n.startswith("request-") and n.endswith(".json")
            )
        except OSError:
            return 0
        done = 0
        for fname in names:
            path = os.path.join(folder, fname)
            try:
                with open(path, encoding="utf-8") as f:
                    req = json.load(f)
            except (OSError, ValueError):
                continue  # half written (an SSH copy): the next tick reads it whole
            n = fname[len("request-") : -len(".json")]
            t0 = time.perf_counter()
            if not isinstance(req, dict):
                answer: dict = {"error": "Not a request"}
            elif str(req.get("pause")) != self.pause:
                answer = {"gone": True}
            else:
                try:
                    answer = self.answer(req)
                except Exception as ex:  # noqa: BLE001 - an answer, never a broken run
                    answer = {"error": render.error_text(ex)}
            answer.update(
                v=VERSION, pause=self.pause, n=req.get("n", n) if isinstance(req, dict) else n
            )
            answer["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            try:
                write_whole(os.path.join(folder, f"answer-{n}.json"), answer)
                os.remove(path)
            except OSError:
                pass
            done += 1
        return done

    def _host(self, req: dict) -> str | dict:
        name = str(req.get("host") or "")
        if name not in self.hosts:
            return {"error": f"{name or 'No host'} does not wait at this pause"}
        return name

    def answer(self, req: dict) -> dict:
        op = req.get("op")
        if op == "watch":
            return self.watch(req)
        host = self._host(req)
        if isinstance(host, dict):
            return host
        if op == "scopes":
            return {"host": host, "scopes": self.view(host).scopes(facts=bool(req.get("facts")))}
        if op in ("vars", "facts"):
            scope = "facts" if op == "facts" else str(req.get("scope") or "host")
            if scope not in capture.SCOPES:
                return {"error": f"No scope {scope}"}
            path = req.get("path") or []
            if not isinstance(path, list):
                return {"error": "path is a list of names and indexes"}
            out = self.view(host).page(
                scope, path, int(req.get("start") or 0), int(req.get("count") or capture.PAGE)
            )
            out.update(host=host, scope=scope)
            return out
        if op == "eval":
            return self.evaluate(host, str(req.get("expr") or ""), req.get("timeout"))
        return {"error": f"Unknown op {op!r}"}

    # ---- evaluate and watch ----------------------------------------------------------------
    def _templar_for(self, host):
        from ansible.template import Templar

        return Templar(loader=self.strategy._loader, variables=self.variables(host))  # noqa: SLF001

    def _result(self, value: object) -> dict:
        """An expression's value as an answer: masked, plain, cut."""
        value = plain(self.session.masker.mask("", value))
        e = entry("result", value)
        e.pop("name", None)
        if e["type"] in ("dict", "list"):
            text = to_json(value)
            if len(text) > capture.VALUE_LIMIT:
                e["value"] = text[: capture.VALUE_LIMIT]
                e["cut"] = len(text)
            else:
                e["value"] = value
        return e

    def _nolog_in(self, expr: str) -> bool:
        """The expression reads a no_log task's register: its result is masked whole."""
        return bool(render.names_in(expr, self.environment()) & self.session.nolog)

    def evaluate(self, host: str, expr: str, timeout: object = None) -> dict:
        refused = render.precheck(expr, self.environment())
        if refused:
            return {"host": host, "expr": expr, "error": refused, "refused": True}
        if self._nolog_in(expr):
            return {"host": host, "expr": expr, "type": "masked", "masked": "no_log"}
        # The plain texts of this host's vaulted values are learned here, before the child.
        self.view(host)
        target = self.hosts[host]

        def work() -> object:
            value = self._templar_for(target).evaluate_expression(render.trusted(expr))
            return self._result(value)

        out = render.in_child(work, float(timeout or render.TIME_LIMIT))
        result = out.pop("value", None)
        answer: dict = {"host": host, "expr": expr, **out}
        if isinstance(result, dict):
            answer.update(result)
        return answer

    def watch(self, req: dict) -> dict:
        exprs = [str(e) for e in (req.get("exprs") or []) if isinstance(e, str)][:50]
        hosts = [str(h) for h in (req.get("hosts") or list(self.hosts)) if str(h) in self.hosts]
        env = self.environment()
        refused = {e: render.precheck(e, env) for e in exprs}
        nolog = {e: not refused[e] and self._nolog_in(e) for e in exprs}
        for h in hosts:
            self.view(h)
        targets = {h: self.hosts[h] for h in hosts}

        def work() -> object:
            rows = []
            for h, target in targets.items():
                templar = self._templar_for(target)
                for e in exprs:
                    if refused[e]:
                        rows.append({"host": h, "expr": e, "error": refused[e], "refused": True})
                        continue
                    if nolog[e]:
                        rows.append({"host": h, "expr": e, "type": "masked", "masked": "no_log"})
                        continue
                    try:
                        value = templar.evaluate_expression(render.trusted(e))
                        rows.append({"host": h, "expr": e, **self._result(value)})
                    except Exception as ex:  # noqa: BLE001
                        rows.append({"host": h, "expr": e, "error": render.error_text(ex)})
            return rows

        limit = float(req.get("timeout") or render.TIME_LIMIT) * max(1, len(exprs))
        out = render.in_child(work, min(limit, render.MAX_TIME_LIMIT))
        if "error" in out:
            return {"error": out["error"], "ms": out.get("ms")}
        return {"results": out.get("value") or [], "ms": out.get("ms")}


# ---- pause points with settings at a step gate ----------------------------------------------
def point_settings(point: Mapping) -> dict:
    out: dict = {}
    cond = point.get("condition")
    if isinstance(cond, str) and cond.strip():
        out["condition"] = cond.strip()
    hits = point.get("hits")
    if isinstance(hits, int) and not isinstance(hits, bool) and hits > 0:
        out["hits"] = hits
    log = point.get("log")
    if isinstance(log, str) and log.strip():
        out["log"] = log
    return out


def at_point(session: Session, strategy, play, hosts: list, node: str, point: Mapping) -> dict:
    """A pause point's settings at its gate, for every host:
    - condition: Jinja per host; all hosts pause if any matches (the matched hosts are named);
      an error is reported and does not pause;
    - hits: hosts arriving here (matching the condition, if any) are counted; it pauses where
      the count reaches N;
    - log: rendered per host (where the condition holds), masked; never pauses.
    Returns {pause, matched, events}: events to append (log lines, errors, the hit count)."""
    settings = point_settings(point)
    cond, hits, log = settings.get("condition"), settings.get("hits"), settings.get("log")
    events: list[dict] = []
    names = [h.get_name() for h in hosts]
    matched = names
    if cond or log:
        gate = Gate(session, strategy, play, hosts, "")
        env = gate.environment()
        bad_cond = render.precheck(cond, env) if cond else None
        bad_log = render.check_template(log, env) if log else None
        for h in names:  # learn the vaulted plain texts before the child masks
            gate.view(h)
        masker = session.masker

        def work() -> object:
            rows = {}
            for h in hosts:
                templar = gate._templar_for(h)
                row: dict = {}
                if cond and not bad_cond:
                    try:
                        row["cond"] = bool(templar.evaluate_conditional(render.trusted(cond)))
                    except Exception as ex:  # noqa: BLE001
                        row["cond"] = render.error_text(ex)
                if log and not bad_log and row.get("cond", True) is True:
                    try:
                        value = templar.template(render.trusted(log))
                        text, kinds = masker.scrub(str(value), value)
                        row["log"] = text
                        if kinds:
                            row["masked"] = sorted(kinds)
                    except Exception as ex:  # noqa: BLE001
                        row["logError"] = render.error_text(ex)
                rows[h.get_name()] = row
            return rows

        out = render.in_child(work, GATE_LIMIT) if not (bad_cond and (bad_log or not log)) else {}
        rows: dict = out.get("value") or {}
        if "error" in out:
            events.append({"event": "log", "node": node, "source": "point", "error": out["error"]})
        if bad_cond:
            events.append({"event": "log", "node": node, "source": "condition", "error": bad_cond})
        if bad_log:
            events.append({"event": "log", "node": node, "source": "log", "error": bad_log})
        if cond:
            matched = []
            for h in names:
                c = rows.get(h, {}).get("cond")
                if c is True:
                    matched.append(h)
                elif isinstance(c, str):
                    events.append(
                        {"event": "log", "node": node, "host": h, "source": "condition", "error": c}
                    )
            if bad_cond or "error" in out:
                matched = []
        if log:
            for h in names:
                row = rows.get(h, {})
                if "log" in row:
                    e = {"event": "log", "node": node, "host": h, "message": row["log"]}
                    if row.get("masked"):
                        e["masked"] = row["masked"]
                    events.append(e)
                elif "logError" in row:
                    events.append(
                        {
                            "event": "log",
                            "node": node,
                            "host": h,
                            "source": "log",
                            "error": row["logError"],
                        }
                    )
    pause = bool(matched) and not log
    if hits:
        before = session.hits.get(node, 0)
        now = before + len(matched)
        session.hits[node] = now
        events.append({"event": "hits", "node": node, "count": now, "hits": hits})
        pause = pause and before < hits <= now
    return {"pause": pause, "matched": matched if cond else [], "events": events}
