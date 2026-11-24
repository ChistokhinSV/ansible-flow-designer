# Taint by reference (ADR-0040 §4, AFD-373): an expression or a template that reads a masked value
# is masked whole, before anything renders it. Matching the result's text (mask.py, check 5) misses
# a value a filter changed (reverse, list, slices, length, hash, comparisons); what the expression
# reads does not change.
#
# The Jinja AST gives each variable read as a root name and a path of constant keys
# (`creds.password`, `hostvars['h2'].x`, `x[0]`). The value at the deepest part of the path that
# exists is checked whole, with everything inside it: a masked part anywhere masks the result.
# - A part of the path chosen at run time (`x[k]`, a slice) stops the path there: the value before
#   it is checked whole.
# - `hostvars` with a host chosen at run time checks that path on every host of the inventory;
#   `hostvars` or `vars` with no path checks every variable.
# - A value that is a template (a raw inventory or play variable) is checked by what it reads.
# - Magic variables (groups, inventory_hostname, ...) hold names and settings, not secrets.
# Only raw values are read here (variable_manager.get_vars): nothing is rendered, no lookup runs.
from __future__ import annotations

import re
from collections.abc import Callable, Mapping

from .capture import MAGIC
from .mask import Masker, _is_hostvars

DYN = object()  # a part of a path chosen at run time
DEPTH = 40
TEMPLATE_DEPTH = 8
# `hostvars[<a host chosen at run time>]` is checked on every host up to this many.
MAX_HOSTS = 300
# Roots read as the variables of a host.
ROOTS = ("hostvars", "vars")


class TooMany(Exception):
    """A hostvars lookup by a host chosen at run time, in an inventory too large to check."""


def _chain(node) -> tuple[str, list] | None:
    """(root name, keys) of a chain of names, attributes and items; None for anything else."""
    from jinja2 import nodes

    keys: list = []
    while True:
        if isinstance(node, nodes.Getattr):
            keys.append(node.attr)
            node = node.node
        elif isinstance(node, nodes.Getitem):
            arg = node.arg
            if (
                isinstance(arg, nodes.Const)
                and isinstance(arg.value, (str, int))
                and not isinstance(arg.value, bool)
            ):
                keys.append(arg.value)
            else:
                keys.append(DYN)
            node = node.node
        elif isinstance(node, nodes.Name):
            keys.reverse()
            return str(node.name), keys
        else:
            return None


def references(ast) -> tuple[list[tuple[str, list]], list[str]]:
    """Every variable an AST reads, as (root, keys), and the string constants that are templates."""
    from jinja2 import nodes

    refs: list[tuple[str, list]] = []
    texts: list[str] = []

    def visit(node) -> None:
        if isinstance(node, (nodes.Getattr, nodes.Getitem, nodes.Name)):
            chain = _chain(node)
            if chain is not None:
                if not (isinstance(node, nodes.Name) and node.ctx != "load"):
                    refs.append(chain)
                # The keys chosen at run time read variables of their own.
                n = node
                while isinstance(n, (nodes.Getattr, nodes.Getitem)):
                    if isinstance(n, nodes.Getitem):
                        visit(n.arg)
                    n = n.node
                return
        if (
            isinstance(node, nodes.Const)
            and isinstance(node.value, str)
            and ("{{" in node.value or "{%" in node.value)
        ):
            texts.append(node.value)
        for child in node.iter_child_nodes():
            visit(child)

    visit(ast)
    return refs, texts


class Taint:
    """What a host's expression reads, checked against the masking. One per pause and host."""

    def __init__(
        self,
        masker: Masker,
        environment,
        variables: Callable[[str], Mapping | None],
        inventory_hosts: Callable[[], list[str]],
        host: str,
        *,
        nolog: set[str] | None = None,
        secret: set[str] | None = None,
    ) -> None:
        self.masker = masker
        self.environment = environment
        self.variables = variables
        self.inventory_hosts = inventory_hosts
        self.host = host
        self.nolog = nolog or set()
        self.secret = secret or set()
        self._templates: set[str] = set()

    # ---- entry points ----------------------------------------------------------------------
    def expression(self, expr: str) -> str | None:
        """Why the result of `expr` (no braces) is masked whole, or None."""
        return self.template("{{ " + expr + " }}")

    def template(self, text: str, depth: int = 0) -> str | None:
        """Why the rendering of `text` is masked whole, or None. An AST that does not parse reads
        nothing here (the render fails on its own)."""
        if depth > TEMPLATE_DEPTH:
            return None
        try:
            ast = self.environment.parse(text)
        except Exception:  # noqa: BLE001
            return None
        refs, texts = references(ast)
        own = self.variables(self.host) or {}
        for root, keys in refs:
            why = self._root(own, root, keys, depth)
            if why:
                return why
        for t in texts:
            why = self._text(t, depth + 1)
            if why:
                return why
        return None

    # ---- a reference -----------------------------------------------------------------------
    def _root(self, own: Mapping, root: str, keys: list, depth: int) -> str | None:
        if root == "hostvars":
            return self._hostvars(keys, depth)
        if root == "vars":
            return self._in_vars(own, keys, depth, whole=True)
        return self._in_vars(own, [root, *keys], depth)

    def _hostvars(self, keys: list, depth: int) -> str | None:
        first = keys[0] if keys else DYN
        known = self.inventory_hosts()
        if first is not DYN and str(first) in known:
            hosts, rest = [str(first)], keys[1:]
        else:
            # A host chosen at run time, or no host at all (`hostvars | dict2items`, `.values()`).
            if len(known) > MAX_HOSTS:
                raise TooMany
            hosts, rest = known, (keys[1:] if keys else [])
        for h in hosts:
            hv = self.variables(h)
            if hv is None:
                continue
            why = self._in_vars(hv, rest, depth, host=h, whole=True)
            if why:
                return why
        return None

    def _in_vars(
        self,
        all_vars: Mapping,
        keys: list,
        depth: int,
        host: str | None = None,
        whole: bool = False,
    ) -> str | None:
        """A path into a host's variables: its first key is a variable's name. A name the host
        does not have reads nothing (undefined, or a Jinja global such as range), unless the path
        is inside `vars` or `hostvars[h]` (`whole`): there it is a method or a lookup by a name
        chosen at run time (`vars.values()`, `vars[k]`), and every variable is checked."""
        if not keys or keys[0] is DYN or str(keys[0]) not in all_vars:
            if not whole and keys and keys[0] is not DYN:
                return None
            for name, value in all_vars.items():
                why = self._variable(str(name), value, [], depth, host)
                if why:
                    return why
            return None
        name = str(keys[0])
        return self._variable(name, all_vars[name], keys[1:], depth, host)

    def _variable(
        self, name: str, value: object, keys: list, depth: int, host: str | None
    ) -> str | None:
        if name in MAGIC and name not in ROOTS:
            return None
        if name in ROOTS:
            return None  # the lazy objects themselves (2.19's `vars` is every variable again)
        if name in self.nolog:
            return "no_log"
        if name in self.secret:
            return "credential"
        # A secret-looking name is the weakest reason: a vaulted, credential, external or no_log
        # value at or inside it says what it truly is (AFS-252).
        why = self.masker.kind(name, value)
        if why and why != "name":
            return why
        weak = why
        for key in keys:
            if key is DYN:
                break
            if isinstance(value, Mapping) and not _is_hostvars(value) and key in value:
                name, value = str(key), value[key]
            elif (
                isinstance(value, (list, tuple))
                and isinstance(key, int)
                and -len(value) <= key < len(value)
            ):
                name, value = "", value[key]
            else:
                break  # an attribute of a value (a method, a missing key): the value is read
            why = self.masker.kind(name, value)
            if why and why != "name":
                return why
            weak = weak or why
        inner = self._inside(value, 0, depth, host)
        return inner if inner and inner != "name" else (weak or inner)

    def _inside(self, value: object, level: int, depth: int, host: str | None) -> str | None:
        """A masked part anywhere inside `value`, or a template there that reads one; a
        secret-looking name only when nothing stronger is found."""
        if level > DEPTH:
            return None
        weak = None
        parts: list[tuple[str, object]] = []
        if isinstance(value, Mapping):
            if _is_hostvars(value):
                return None
            parts = [(str(k), v) for k, v in value.items()]
        elif isinstance(value, (list, tuple, set, frozenset)):
            parts = [("", v) for v in value]
        elif isinstance(value, str):
            text = str.__str__(value)
            if "{{" in text or "{%" in text:
                return self._text(text, depth + 1, host)
            return None
        for k, v in parts:
            for why in (self.masker.kind(k, v), self._inside(v, level + 1, depth, host)):
                if why and why != "name":
                    return why
                weak = weak or why
        return weak

    def _text(self, text: str, depth: int, host: str | None = None) -> str | None:
        """A template inside a value: what it reads, as the host that has it."""
        key = f"{host or self.host}\0{text}"
        if key in self._templates or depth > TEMPLATE_DEPTH:
            return None
        self._templates.add(key)
        if host is None or host == self.host:
            return self.template(text, depth)
        other = Taint(
            self.masker,
            self.environment,
            self.variables,
            self.inventory_hosts,
            host,
            nolog=self.nolog,
            secret=self.secret,
        )
        other._templates = self._templates
        return other.template(text, depth)


def mask_blocks(
    environment, text: str, why: Callable[[str], str | None]
) -> tuple[str | None, set[str]]:
    """A log message with each `{{ ... }}` that reads a masked value replaced by the mask, so the
    rest still renders ("sw-01 cred=********"); `why(expr)` says why an expression is masked.
    Returns (the template to render, the kinds), or (None, kinds) when the message is masked
    whole: a `{% ... %}` that reads a masked value, or a template the lexer cannot read."""
    from .mask import REDACTED

    try:
        tokens = list(environment.lex(text))
    except Exception:  # noqa: BLE001
        return None, {"name"}
    out: list[str] = []
    kinds: set[str] = set()
    block: list[tuple[str, str]] | None = None
    for _line, kind, value in tokens:
        if kind in ("variable_begin", "block_begin"):
            block = [(kind, value)]
            continue
        if block is None:
            out.append(value)
            continue
        block.append((kind, value))
        if kind not in ("variable_end", "block_end"):
            continue
        source = "".join(v for _k, v in block)
        inner = "".join(v for _k, v in block[1:-1])
        opened = block[0][0]
        block = None
        if opened == "block_begin":
            # A statement (for, if, set): what it reads shapes the whole message.
            found = why_statement(inner, why)
            if found:
                return None, {found}
            out.append(source)
            continue
        found = why(inner)
        if found:
            kinds.add(found)
            out.append(REDACTED)
        else:
            out.append(source)
    if block is not None:  # not closed: the render reports the error
        out.extend(v for _k, v in block)
    return "".join(out), kinds


# Statements that read no expression.
QUIET = {"else", "endif", "endfor", "endset", "raw", "endraw", "endfilter", "endwith", "endcall"}


def why_statement(inner: str, why: Callable[[str], str | None]) -> str | None:
    """A `{% ... %}` statement's expression: `if <expr>`, `for x in <expr>`, `set x = <expr>`.
    Any other statement (with, macro, call, filter) masks the message when the message as a whole
    reads a masked value (`why` of an empty expression is that kind)."""
    text = inner.strip().lstrip("-+").rstrip("-+").strip()
    word = text.split(None, 1)[0] if text else ""
    if word in QUIET:
        return None
    m = re.match(r"(?:el)?if\s+(.*)$|for\s+.+?\s+in\s+(.*)$|set\s+[^=]+=\s*(.*)$", text, re.S)
    if m is None:
        return why("")
    expr = next(g for g in m.groups() if g is not None)
    # `for x in items if cond`, `... recursive`: the whole tail is read.
    return why(expr.removesuffix(" recursive"))
