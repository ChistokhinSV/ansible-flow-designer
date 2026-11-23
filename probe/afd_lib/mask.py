# Masking in the engine (ADR-0040 §4, AFS-223): a value leaves a debug run masked, with the reason
# and never its length. Five checks:
# 1. data tags: an EncryptedString, or a value with the VaultedValue tag (they survive a whole value
#    and set_fact, and each leaf of a dict or list);
# 2. origin in a vault file: whole-file vault values carry no VaultedValue tag, only an Origin
#    naming a file that starts with $ANSIBLE_VAULT;
# 3. secret-looking names at any depth;
# 4. no_log results (_ansible_no_log): the whole register;
# 5. known values: credential values (AFD_SECRETS_FILE), external secrets resolved by a server
#    (AFD_EXTERNAL_SECRETS_FILE), the vault password (AFD_VAULT_FILE), the plain texts of vaulted
#    values and the values under secret-looking names, each in its plain, base64, JSON-escaped and
#    URL-quoted forms, case ignored. Filters drop the tags (b64encode, to_json, `~`): the text is
#    what is left to match.
from __future__ import annotations

import base64
import contextlib
import json
import os
import re
import urllib.parse
from collections.abc import Mapping

try:  # ansible-core 2.19+: data tagging
    from ansible._internal._datatag._tags import Origin, VaultedValue
    from ansible.module_utils._internal._datatag import AnsibleTagHelper
    from ansible.parsing.vault import EncryptedString

    TAGS = True
except ImportError:  # pragma: no cover - older cores: the debugger refuses to run there
    TAGS = False

# The import rules' secret-looking names (src/core/import/secrets.ts SECRET, afd_events.py).
SECRET_NAME = re.compile(r"pass(word|wd)?|secret|token|api_?key|private_?key|vault", re.IGNORECASE)
# Shorter known values are not matched: they would mask ordinary words and numbers.
MIN_KNOWN = 4
REDACTED = "********"
KINDS = ("vault", "no_log", "credential", "external", "name")
DEPTH = 40


class Masked:
    """A masked value: what goes out in its place is {"__afd__": "masked", "masked": kind}."""

    __slots__ = ("kind",)

    def __init__(self, kind: str) -> None:
        self.kind = kind


def leaves(value: object, out: set[str], depth: int = 0) -> None:
    """Every string and number inside a value; a dict or list also as its compact JSON."""
    if depth > DEPTH or isinstance(value, bool) or value is None:
        return
    if isinstance(value, (str, int, float)):
        text = str.__str__(value) if isinstance(value, str) else str(value)
        if text:
            out.add(text)
    elif isinstance(value, Mapping):
        with contextlib.suppress(TypeError, ValueError):
            out.add(json.dumps(value, separators=(",", ":"), default=str))
        for v in value.values():
            leaves(v, out, depth + 1)
    elif isinstance(value, (list, tuple)):
        with contextlib.suppress(TypeError, ValueError):
            out.add(json.dumps(value, separators=(",", ":"), default=str))
        for v in value:
            leaves(v, out, depth + 1)


def forms(secret: str) -> set[str]:
    """The forms a task commonly turns a secret into: plain, base64, JSON-escaped, URL-quoted."""
    out = {secret}
    raw = secret.encode("utf-8", "surrogatepass")
    out.add(base64.b64encode(raw).decode())
    out.add(json.dumps(secret, ensure_ascii=False)[1:-1])
    out.add(json.dumps(secret)[1:-1])
    out.add(urllib.parse.quote(secret, safe=""))
    return {f for f in out if len(f) >= MIN_KNOWN}


class Known:
    """Known secret values, each with the kind it is masked as; the first kind given stays."""

    def __init__(self) -> None:
        self._kinds: dict[str, str] = {}
        self._re: re.Pattern[str] | None = None
        self._dirty = False

    def __len__(self) -> int:
        return len(self._kinds)

    def add(self, value: object, kind: str) -> None:
        found: set[str] = set()
        leaves(value, found)
        for text in found:
            for f in forms(text):
                key = f.lower()
                if key not in self._kinds:
                    self._kinds[key] = kind
                    self._dirty = True

    def _pattern(self) -> re.Pattern[str] | None:
        if self._dirty:
            # Longest first: a secret that holds another is matched whole.
            keys = sorted(self._kinds, key=len, reverse=True)
            self._re = re.compile("|".join(re.escape(k) for k in keys), re.IGNORECASE)
            self._dirty = False
        return self._re if self._kinds else None

    def find(self, text: str) -> str | None:
        """The kind of the first known value inside `text`, or None."""
        pattern = self._pattern()
        if pattern is None:
            return None
        m = pattern.search(text)
        return self._kinds.get(m.group(0).lower(), "credential") if m else None

    def scrub(self, text: str) -> tuple[str, set[str]]:
        """`text` with every known value replaced; the kinds that were found."""
        pattern = self._pattern()
        if pattern is None:
            return text, set()
        kinds: set[str] = set()

        def repl(m: re.Match[str]) -> str:
            kinds.add(self._kinds.get(m.group(0).lower(), "credential"))
            return REDACTED

        return pattern.sub(repl, text), kinds


def _json_file(path: str | None) -> object:
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_known() -> Known:
    """The run's known secrets, from the files its shell names (never from the environment)."""
    known = Known()
    # External secrets first: the first kind given stays, and a value a provider resolved is also
    # a credential's variable (a login or become password) when a credential reads it from there.
    external = _json_file(os.environ.get("AFD_EXTERNAL_SECRETS_FILE"))
    if isinstance(external, Mapping):
        for v in external.values():
            known.add(v, "external")
    elif isinstance(external, list):
        known.add(external, "external")
    secrets = _json_file(os.environ.get("AFD_SECRETS_FILE"))
    if isinstance(secrets, Mapping):
        for v in secrets.values():
            known.add(v, "credential")
    path = os.environ.get("AFD_VAULT_FILE")
    if path:
        try:
            with open(path, encoding="utf-8") as f:
                password = f.read().rstrip("\r\n")
            if password:
                known.add(password, "vault")
        except OSError:
            pass
    return known


def is_vaulted(value: object) -> bool:
    """Still encrypted (EncryptedString), or decrypted and tagged VaultedValue."""
    if not TAGS:
        return False
    if isinstance(value, EncryptedString):
        return True
    try:
        return VaultedValue in AnsibleTagHelper.tag_types(value)
    except Exception:  # noqa: BLE001 - a value that cannot say its tags has none
        return False


class Masker:
    """One per process: known values grow as vaulted values are met (their plain texts)."""

    def __init__(self, known: Known | None = None) -> None:
        self.known = known if known is not None else load_known()
        self._vault_files: dict[str, bool] = {}
        # Ciphertexts already decrypted: PBKDF2 costs about 10 ms each.
        self._seen: set[str] = set()

    def from_vault_file(self, value: object) -> bool:
        if not TAGS or not isinstance(value, (str, Mapping, list)):
            return False
        try:
            origin = Origin.get_tag(value)
        except Exception:  # noqa: BLE001
            return False
        path = getattr(origin, "path", None)
        if not path:
            return False
        if path not in self._vault_files:
            try:
                with open(path, "rb") as f:
                    self._vault_files[path] = f.read(14) == b"$ANSIBLE_VAULT"
            except OSError:
                self._vault_files[path] = False
        return self._vault_files[path]

    def _plain_of(self, value: object) -> str | None:
        """The plain text of a vaulted value, for the known values only (never output)."""
        if TAGS and isinstance(value, EncryptedString):
            key = str(getattr(value, "_ciphertext", ""))
            if key in self._seen:
                return None
            self._seen.add(key)
            try:
                return str.__str__(value._decrypt())  # noqa: SLF001
            except Exception:  # noqa: BLE001 - no password for it: nothing to learn
                return None
        if isinstance(value, str) and (is_vaulted(value) or self.from_vault_file(value)):
            return str.__str__(value)
        return None

    def learn(self, value: object, depth: int = 0, secret: bool = False) -> None:
        """Learns the plain texts of vaulted values inside `value`, and the values under
        secret-looking names, so derived copies (b64, JSON, concatenation) are caught."""
        if depth > DEPTH:
            return
        plain = self._plain_of(value)
        if plain:
            self.known.add(plain, "vault")
            return
        if isinstance(value, Mapping):
            if _is_hostvars(value):
                return
            for k, v in value.items():
                self.learn(v, depth + 1, secret or bool(SECRET_NAME.search(str(k))))
        elif isinstance(value, (list, tuple)):
            for v in value:
                self.learn(v, depth + 1, secret)
        elif secret and isinstance(value, (str, int, float)) and not isinstance(value, bool):
            text = str.__str__(value) if isinstance(value, str) else str(value)
            # A template is not the secret: its value is not known here.
            if "{{" not in text and "{%" not in text:
                self.known.add(text, "name")

    def kind(self, name: str, value: object) -> str | None:
        """Why `value` under `name` is masked whole, or None."""
        if is_vaulted(value) or self.from_vault_file(value):
            return "vault"
        if name and SECRET_NAME.search(str(name)):
            return "name"
        if isinstance(value, Mapping) and not _is_hostvars(value):
            try:
                if value.get("_ansible_no_log") or _censored(value.get("censored")):
                    return "no_log"
            except Exception:  # noqa: BLE001
                return None
        if isinstance(value, str):
            return self.known.find(str.__str__(value))
        return None

    def mask(self, name: str, value: object, depth: int = 0) -> object:
        """`value` (raw Ansible data) with each masked part replaced by a Masked."""
        why = self.kind(name, value)
        if why:
            return Masked(why)
        if depth > DEPTH:
            return value
        if isinstance(value, Mapping) and not _is_hostvars(value):
            return {k: self.mask(str(k), v, depth + 1) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [self.mask("", v, depth + 1) for v in value]
        return value

    def scrub(self, text: str, value: object = None) -> tuple[str, set[str]]:
        """A log line: a vaulted result is masked whole, known values inside it are replaced."""
        if value is not None and is_vaulted(value):
            return REDACTED, {"vault"}
        return self.known.scrub(text)


def _censored(text: object) -> bool:
    """The text a no_log result keeps in place of its output (registered without the flag)."""
    return isinstance(text, str) and "no_log: true" in text


def _is_hostvars(value: object) -> bool:
    return type(value).__name__ in ("HostVars", "HostVarsVars")
