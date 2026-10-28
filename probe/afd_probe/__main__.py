"""Entry point: python -m afd_probe serve --root <repo>."""

from __future__ import annotations

import argparse
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="afd_probe", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="JSON-lines session on stdin/stdout")
    serve.add_argument("--root", required=True, help="repository root as seen by the probe")
    args = parser.parse_args(argv)
    if args.command == "serve":
        from afd_probe.serve import serve as run

        return run(args.root)
    return 2


if __name__ == "__main__":
    sys.exit(main())
