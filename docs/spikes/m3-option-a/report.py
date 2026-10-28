"""Summarises an ansible.posix.json callback run: REPORT/SHOW messages and per-host stats."""

import json
import sys

raw = open(sys.argv[1], encoding="utf-8").read()
start = raw.find("{")
if start < 0:
    print("  no JSON output")
    sys.exit(0)
data = json.loads(raw[start:])
print("  plays run:", [p["play"]["name"] for p in data.get("plays", [])])
for p in data.get("plays", []):
    for t in p["tasks"]:
        name = t["task"]["name"]
        if name == "REPORT" or name.startswith("SHOW"):
            for host, res in t["hosts"].items():
                print(f"  {name} [{host}]:", json.dumps(res.get("msg", res.get("skip_reason"))))
for host, s in sorted(data.get("stats", {}).items()):
    extra = {k: v for k, v in s.items() if v and k != "ok"}
    print(f"  stats {host}: ok={s.get('ok', 0)} {extra}")
