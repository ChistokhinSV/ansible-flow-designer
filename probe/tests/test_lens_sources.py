"""Dynamic inventory sources are told apart from static files without Ansible (M8)."""

from __future__ import annotations

import os
import stat

from afd_probe.lens import _dynamic


def test_plugin_configs_and_scripts_are_dynamic(tmp_path):
    inv = tmp_path / "inventory"
    inv.mkdir()
    (inv / "hosts.yml").write_text("all:\n  hosts:\n    h1: {}\n")
    (inv / "aws.yml").write_text("plugin: amazon.aws.aws_ec2\nregions: [eu-west-1]\n")
    script = inv / "cmdb"
    script.write_text("#!/bin/sh\necho '{}'\n")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    found = _dynamic(str(tmp_path), ["inventory"])
    assert os.path.join("inventory", "aws.yml") in found
    assert os.path.join("inventory", "hosts.yml") not in found
    if os.name != "nt":  # the exec bit means nothing on Windows
        assert os.path.join("inventory", "cmdb") in found
