# Safe render at a pause (ADR-0040 §5, AFD-370): evaluate, watch, pause point conditions and log
# messages. Before rendering, the Jinja AST is checked: lookup, query and q calls and the vault and
# unvault filters are refused. The render runs in a forked child: lookups blocked while it runs
# (also those a lazy variable runs, which disable_lookups misses), a memory cap, and a time limit
# the parent enforces by killing the child. No SIGALRM: an in-process alarm corrupted the template
# context on 2.19 and did not stop a loop on 2.21. Nothing the child changes reaches the run.
from __future__ import annotations

import json
import os
import resource
import select
import signal
import time
from collections.abc import Callable

try:
    from ansible._internal._datatag._tags import TrustedAsTemplate

    TAGS = True
except ImportError:  # pragma: no cover
    TAGS = False

TIME_LIMIT = 2.0
MAX_TIME_LIMIT = 10.0
MEMORY_EXTRA = 512 * 1024 * 1024
EXPR_LIMIT = 4000
# Lookups a lazy variable may still run while rendering: they read only what is already there.
LOOKUP_ALLOW = {
    "vars", "varnames", "items", "list", "dict", "indexed_items", "sequence", "subelements",
    "nested", "together", "cartesian",
}  # fmt: skip
LOOKUP_CALLS = {"lookup", "query", "q"}
FILTER_DENY = {"vault", "unvault"}


class Blocked(Exception):
    pass


def _short(name: object) -> str:
    return str(name).rsplit(".", 1)[-1]


def precheck(expr: str, environment, where: str = "Evaluate") -> str | None:
    """Why `expr` is refused before anything renders it, in plain words; None when it may run.
    `where` names what refuses it ("Evaluate", "a condition")."""
    if not expr.strip():
        return "Nothing to evaluate"
    if len(expr) > EXPR_LIMIT:
        return f"The expression is longer than {EXPR_LIMIT} characters"
    if any(m in expr for m in ("{{", "}}", "{%", "%}", "{#", "#}")):
        return "Write an expression without {{ }} or {% %}"
    unclosed = not_closed(expr)
    if unclosed:
        return unclosed
    return check_template("{{ " + expr + " }}", environment, where, expression=True)


def refusal(text: str) -> dict:
    """A precheck's answer: refused (a lookup, a vault filter, a name starting with _: what
    Evaluate does not allow), or an error (a bracket or quote not closed, not Jinja: the
    expression is not finished, nothing was refused)."""
    return {"error": text, "refused": True} if "not allowed" in text else {"error": text}


PAIRS = {"(": ")", "[": "]", "{": "}"}


def not_closed(expr: str) -> str | None:
    """A bracket or quote the expression opens and never closes (or closes without opening), in
    words: Jinja's own error names the `}}` the expression is wrapped in, never typed."""
    stack: list[str] = []
    quote = ""
    escaped = False
    for ch in expr:
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
            continue
        if ch in ("'", '"'):
            quote = ch
        elif ch in PAIRS:
            stack.append(ch)
        elif ch in PAIRS.values():
            if not stack or PAIRS[stack[-1]] != ch:
                return f"A {ch} has no opening bracket before it"
            stack.pop()
    if quote:
        return f"A quote ({quote}) is not closed"
    if stack:
        return f"A bracket ({stack[-1]}) is not closed"
    return None


def _syntax(ex: BaseException, expression: bool) -> str:
    """Jinja's syntax error in plain words, without the parser's own terms."""
    text = (str(ex).strip().splitlines() or [""])[0]
    if expression:
        text = (
            text.replace("expected token 'end of print statement'", "expected the end")
            .replace("'end of print statement'", "the end")
            .replace("unexpected '}'", "unexpected end")
            .replace("unexpected end of template", "unexpected end")
        )
    return text[:300]


def check_template(
    text: str, environment, where: str = "a log message", expression: bool = False
) -> str | None:
    """Why a template (a log message, an expression in braces) is refused; None when it may run.
    `where` names what refuses it, in the words: "lookups are not allowed in Evaluate"."""
    try:
        from jinja2 import nodes

        ast = environment.parse(text)
    except Exception as ex:  # noqa: BLE001
        what = "Not a Jinja expression" if expression else "Not a Jinja template"
        return f"{what}: {_syntax(ex, expression)}"
    lookups = f"lookups are not allowed in {where}: they can read files or run commands"
    for call in ast.find_all(nodes.Call):
        if isinstance(call.node, nodes.Name) and call.node.name in LOOKUP_CALLS:
            return f"{call.node.name}(): {lookups}"
    for name in ast.find_all(nodes.Name):
        if name.name in LOOKUP_CALLS:
            return f"{name.name}: {lookups}"
    for f in ast.find_all(nodes.Filter):
        if _short(f.name) in FILTER_DENY:
            return f"The {f.name} filter is not allowed in {where}"
    for attr in ast.find_all(nodes.Getattr):
        if str(attr.attr).startswith("_"):
            return f"Attributes starting with _ are not allowed in {where}"
    for name in ast.find_all(nodes.Name):
        if str(name.name).startswith("_"):
            return f"Names starting with _ are not allowed in {where}"
    return None


def names_in(expr: str, environment) -> set[str]:
    """The variable names an expression reads."""
    try:
        from jinja2 import nodes

        ast = environment.parse("{{ " + expr + " }}")
    except Exception:  # noqa: BLE001
        return set()
    return {n.name for n in ast.find_all(nodes.Name)}


def block_lookups() -> None:
    """Every lookup outside LOOKUP_ALLOW raises. Patches the module global the templating engine
    uses (a private one: the engine suite checks it on every core): call it in the child only."""
    import ansible._internal._templating._jinja_plugins as jp

    real = jp.lookup_loader

    class _Guard:
        def get(self, name, *a, **kw):
            if _short(name) not in LOOKUP_ALLOW:
                raise Blocked(
                    f"lookups are not allowed while debugging (a variable runs lookup {name!r})"
                )
            return real.get(name, *a, **kw)

        def __getattr__(self, attr):
            return getattr(real, attr)

    jp.lookup_loader = _Guard()


def trusted(text: str) -> object:
    return TrustedAsTemplate().tag(text) if TAGS else text


def _vm_bytes() -> int:
    try:
        with open("/proc/self/statm") as f:
            return int(f.read().split()[0]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError):
        return 0


def error_text(ex: BaseException) -> str:
    text = str(ex).strip().splitlines()
    first = text[0] if text else ""
    if isinstance(ex, MemoryError):
        return "The expression needed more memory than a debugger may use"
    return f"{type(ex).__name__}: {first[:400]}" if first else type(ex).__name__


def in_child(fn: Callable[[], object], timeout: float = TIME_LIMIT) -> dict:
    """Runs fn() in a forked child with a memory cap; the parent kills it at `timeout`.
    Returns {"value": <JSON>} or {"error": <text>}, and the time it took in ms."""
    timeout = max(0.1, min(float(timeout), MAX_TIME_LIMIT))
    r, w = os.pipe()
    t0 = time.perf_counter()
    pid = os.fork()
    if pid == 0:  # the child: no display, no logging; it ends with os._exit
        try:
            os.close(r)
            base = _vm_bytes()
            if base:
                limit = base + MEMORY_EXTRA
                resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
            block_lookups()
            data = json.dumps({"value": fn()}, default=str).encode()
        except BaseException as ex:  # noqa: BLE001
            try:
                data = json.dumps({"error": error_text(ex)}).encode()
            except BaseException:  # noqa: BLE001
                data = b'{"error": "The expression failed"}'
        try:
            view = memoryview(data)
            while view:
                n = os.write(w, view)
                view = view[n:]
        finally:
            os._exit(0)
    os.close(w)
    chunks: list[bytes] = []
    deadline = time.monotonic() + timeout
    killed = False
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                os.kill(pid, signal.SIGKILL)
                killed = True
                break
            ready, _, _ = select.select([r], [], [], left)
            if ready:
                chunk = os.read(r, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
    finally:
        os.close(r)
        os.waitpid(pid, 0)
    ms = round((time.perf_counter() - t0) * 1000, 1)
    if killed:
        return {
            "error": f"Stopped after the time limit of {timeout:g} s",
            "ms": ms,
            "timeout": True,
        }
    try:
        out = json.loads(b"".join(chunks) or b'{"error": "No answer (the memory limit?)"}')
    except ValueError:
        out = {"error": "No answer (the memory limit?)"}
    out["ms"] = ms
    return out
