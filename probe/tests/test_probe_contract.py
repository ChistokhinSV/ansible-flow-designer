"""Contract tests: the real probe inside each Ansible image (ADR-0005). Needs Docker.

Images come from AFD_PROBE_IMAGES (comma-separated), default the three stand-in EEs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PROBE = REPO / "probe"
IMAGES = os.environ.get(
    "AFD_PROBE_IMAGES", "ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21"
).split(",")

pytestmark = pytest.mark.docker


class Session:
    def __init__(self, image: str) -> None:
        # The catalog cache is the one writable mount, as in the extension (M5).
        self.cache = Path(tempfile.mkdtemp(prefix="afd-cache-"))
        self.proc = subprocess.Popen(
            [
                "docker",
                "run",
                "-i",
                "--rm",
                "-v",
                f"{REPO}:/work:ro",
                "-v",
                f"{PROBE}:/afd:ro",
                "-v",
                f"{self.cache}:/afd-cache",
                "-e",
                "ANSIBLE_ROLES_PATH=/work/probe/tests/fixtures/roles:/work/test/fixtures/drift/roles",
                "-e",
                "PYTHONPATH=/afd",
                "-e",
                "PYTHONDONTWRITEBYTECODE=1",
                "-w",
                "/work",
                image,
                "python3",
                "-m",
                "afd_probe",
                "serve",
                "--root",
                "/work",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
        )
        self.ready = self._read()
        self.next = 1

    def _read(self) -> dict:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        assert line, "probe ended"
        return json.loads(line)

    def call(self, method: str, **params) -> dict:
        assert self.proc.stdin is not None
        req = {"id": self.next, "method": method, "params": params}
        self.next += 1
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        reply = self._read()
        assert reply["id"] == req["id"]
        return reply

    def close(self) -> None:
        if self.proc.stdin:
            self.proc.stdin.close()
        self.proc.wait(timeout=30)
        shutil.rmtree(self.cache, ignore_errors=True)


@pytest.fixture(scope="module", params=IMAGES)
def probe(request):
    session = Session(request.param)
    yield session
    session.close()


def test_ready_line_names_versions(probe):
    assert probe.ready["kind"] == "ready"
    assert probe.ready["ansible_core"].startswith("2.")
    assert probe.ready["root"] == "/work"


def test_unknown_method_and_bad_params_keep_the_session(probe):
    assert probe.call("nope")["error"]["type"] == "LookupError"
    assert "error" in probe.call("inventory", bogus=1)
    assert probe.call("ping")["result"] == {"ok": True}


def test_inventory_resolves_targets_and_flags(probe):
    inv = "test/fixtures/engine/content/inventory.ini"
    result = probe.call("inventory", inventory=inv, targets=["sw-edge-01", "h07", "sw-ghost-09"])[
        "result"
    ]
    assert result["count"] == 2
    assert result["hosts"] == ["sw-edge-01", "h07"]
    assert result["unknown"] == ["sw-ghost-09"]
    # edge_switches has edge as a child (AFD-14 override targets in the engine inventory).
    assert result["groups"] == {"edge": 1, "edge_switches": 1, "lab": 1}
    assert result["prod_groups"] == []
    assert result["vault"] is False


def test_inventory_tree_lists_groups_hosts_and_children(probe):
    inv = "test/fixtures/engine/content/inventory.ini"
    result = probe.call("inventory_tree", inventory=inv)["result"]
    groups = {g["name"]: g for g in result["groups"]}
    assert result["total"] == 15
    assert groups["edge"]["hosts"] == ["sw-edge-01", "sw-edge-02", "sw-edge-03", "sw-edge-04"]
    # A parent group lists its children, not their hosts; its count has them all.
    assert groups["edge_switches"]["hosts"] == []
    assert groups["edge_switches"]["children"] == ["edge"]
    assert groups["edge_switches"]["count"] == 4
    assert "lab" in groups["all"]["children"]


def test_inventory_detects_production_and_vault(probe):
    inv = "probe/tests/fixtures/prod/inventory.ini"
    result = probe.call("inventory", inventory=inv, targets=["core-prd-01", "lab-sw-01"])["result"]
    assert result["prod_groups"] == ["dc_prod"]
    assert result["prod_hosts"] == ["core-prd-01"]
    assert result["vault"] is True


def test_syntax_check_accepts_generated_examples(probe):
    for playbook in (
        "examples/generated/edge-baseline.yml",
        "examples/generated/os-upgrade-edge.yml",
    ):
        result = probe.call(
            "syntax_check", playbook=playbook, extra_vars={"devices": ["localhost"]}
        )["result"]
        assert result["ok"], result["output"]


def test_syntax_check_reports_origin(probe):
    result = probe.call("syntax_check", playbook="probe/tests/fixtures/broken.yml")["result"]
    assert result["ok"] is False
    first = result["errors"][0]
    assert first["path"].endswith("probe/tests/fixtures/broken.yml")
    assert first["line"] == 4


def test_catalog_dumps_into_the_cache_once(probe):
    first = probe.call("catalog", cache="/afd-cache", jobs=2, only=["ansible.builtin"])["result"]
    builtin = next(c for c in first["collections"] if c["name"] == "ansible.builtin")
    assert builtin["version"] == probe.ready["ansible_core"]
    assert builtin["dumped"] is True and "error" not in builtin
    data = json.loads((probe.cache / builtin["file"]).read_text(encoding="utf-8"))
    assert data["format"] == 1
    ping = next(p for p in data["plugins"] if p["fqcn"] == "ansible.builtin.ping")
    assert ping["type"] == "module" and ping["short_description"]
    assert ping["attributes"]["check_mode"]["support"] == "full"
    assert any(p["type"] == "keyword" and p["fqcn"] == "until" for p in data["plugins"])
    # Short names of the old builtin modules redirect into collections (resolver, 07 2).
    assert data["routing"]["module"]["ios_config"]["redirect"] == "cisco.ios.ios_config"
    again = probe.call("catalog", cache="/afd-cache", jobs=2, only=["ansible.builtin"])["result"]
    assert again["dumped"] == 0


def test_roles_read_argument_specs(probe):
    roles = probe.call("roles")["result"]
    role = next(r for r in roles if r["name"] == "edge_report")
    assert role["tasks"] == ["main", "verify"]
    main = role["entry_points"]["main"]
    assert main["short_description"] == "Report the edge baseline of a site"
    assert main["options"]["site"]["required"] is True
    assert main["options"]["site"]["type"] == "str"
    assert "verify" in role["entry_points"]


DRIFT = "test/fixtures/drift"


def test_compile_matches_generated_plays_to_nodes(probe):
    generated = f"{DRIFT}/flows/edge-drift/generated/edge-drift.yml"
    result = probe.call("compile", playbooks=[generated, "missing.yml"])["result"]
    book, missing = result["playbooks"]
    assert missing["error"] == "not found"
    tags = {t for p in book["plays"] for t in p["tags"] if t.startswith("node_")}
    # Top level, the imported subflow level, and the bound playbook's own play.
    for node in ("05", "11", "12", "02"):
        assert f"node_01JCR6N00000000000000000{node}" in tags
    validate = next(p for p in book["plays"] if p["name"].startswith("[validate]"))
    assert validate["origin"]["path"] == generated
    assert isinstance(validate["origin"]["line"], int)
    precheck = next(p for p in book["plays"] if p["name"] == "Pre-checks")
    assert precheck["origin"]["path"] == f"{DRIFT}/playbooks/precheck.yml"
    assert [t["action"] for t in precheck["tasks"]] == [
        "ansible.builtin.ping",
        "ansible.builtin.debug",
    ]
    # Role bindings are dynamic in generated code: compile lists the include, not its tasks.
    assert any(t["dynamic"] for t in validate["tasks"])


def test_compile_expands_roles_and_skips_the_spec_check(probe):
    roles = [
        {"name": "netops_validate"},
        {"name": "push_baseline", "tasks_from": "ntp"},
        {"name": "push_baseline"},
        {"name": "not_a_role"},
    ]
    validate, ntp, whole, nope = probe.call("compile", roles=roles)["result"]["roles"]
    real = [t for t in validate["tasks"] if not t["auto"]]
    assert [t["action"] for t in real] == ["ansible.builtin.command"]
    assert real[0]["register"] == ["diff_report"]
    assert real[0]["origin"]["path"] == f"{DRIFT}/roles/netops_validate/tasks/main.yml"
    assert any(
        t["action"].endswith("validate_argument_spec") for t in validate["tasks"] if t["auto"]
    )
    assert [t["name"] for t in ntp["tasks"]] == ["Push NTP servers"]
    assert [t["dynamic"] for t in whole["tasks"]] == [True, True, True]
    assert "not_a_role" in nope["error"] and nope["tasks"] == []


def test_inventory_lens_counts_patterns_and_never_decrypts(probe):
    """M8 Inventory and Access lenses: counts, hosts outside the targets, origins, vault names."""
    inv = "test/fixtures/lens/inventory/hosts.yml"
    patterns = ["edge_switches", "core_spines", "edge_switches,core_spines", "all", "ghost_group"]
    raw = probe.call("inventory_lens", inventory=inv, targets="edge_switches", patterns=patterns)
    r = raw["result"]
    assert r["total"] == 9
    assert r["patterns"]["edge_switches"] == {"count": 6, "outside": 0, "sample": []}
    assert r["patterns"]["core_spines"]["count"] == 2
    assert r["patterns"]["core_spines"]["outside"] == 2
    assert r["patterns"]["edge_switches,core_spines"]["count"] == 8
    assert (r["patterns"]["all"]["count"], r["patterns"]["all"]["outside"]) == (9, 3)
    assert len(r["patterns"]["all"]["sample"]) == 3
    assert r["patterns"]["ghost_group"]["count"] == 0
    assert r["scope"]["count"] == 9
    assert r["scope"]["groups"] == {"core_spines": 2, "dc_prod": 2, "edge_switches": 6}
    assert r["prod_groups"] == ["dc_prod"]
    spines = r["access"]["core_spines"]
    assert spines["ansible_user"]["values"] == {"spine-admin": 2}
    assert spines["ansible_user"]["origins"] == [
        "test/fixtures/lens/inventory/group_vars/core_spines.yml:2"
    ]
    assert spines["ansible_become"]["values"] == {"true": 2}
    assert r["access"]["edge_switches"]["ansible_user"]["values"] == {"netops": 6}
    assert r["vaulted"] == {
        "spine_enable_secret": "test/fixtures/lens/inventory/group_vars/core_spines.yml:3"
    }
    # The vaulted value is never read: neither the plaintext nor the ciphertext comes back.
    text = json.dumps(raw)
    assert "fictional" not in text
    assert "$ANSIBLE_VAULT" not in text
    assert r["dynamic"] == []
