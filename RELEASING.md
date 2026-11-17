# Releasing

From 1.0 no version is released before it was tested by hand: a **release candidate** is
published where testers get it, tested with the
[release test plan](docs/testing/release-test-plan.md) (and, with Ansible Flow Server, on its
staging server), and only then released.

The whole process, staging included, is in Ansible Flow Server's
[RELEASING.md](https://github.com/ChistokhinSV/ansible-flow-server/blob/main/RELEASING.md): the
designer and the server are released together whenever the designer changed, since the server
carries the designer's packages. This page is the designer's part.

## Versions

- The designer and the server have their own minor and patch versions; the **major** versions go
  together (Ansible Flow Server 1.x carries designer 1.x).
- The extension and the npm packages (`@ansible-flow/core`, `node`, `designer`, `assets`) have
  one version.

| Tag           | npm packages      | VSIX                                  |
| ------------- | ----------------- | ------------------------------------- |
| `vX.Y.Z`      | dist-tag `latest` | Marketplace, Open VSX, GitHub release |
| `vX.Y.Z-rc.N` | dist-tag `next`   | GitHub **pre-release** only           |

`npm install @ansible-flow/core` and the Marketplace never give a candidate; the server pins one
by its exact version (`1.1.0-rc.1`).

## A candidate

1. Every change has its YouTrack ticket, a line under `## Unreleased` in `CHANGELOG.md`, and the
   knowledge base updated.
2. `just check`, `just test`, the engine suite and `just test-int` pass.
3. `npm version X.Y.Z-rc.N --no-git-tag-version`; commit "Release candidate X.Y.Z-rc.N"; tag
   `vX.Y.Z-rc.N`; push the commit and the tag. Publish puts the packages on `next` and the VSIX
   on a GitHub pre-release (its notes: the Unreleased section).
4. Install the VSIX from the pre-release (**Extensions: Install from VSIX…**) and test with the
   [release test plan](docs/testing/release-test-plan.md): its core part, and a check for each
   Unreleased line. With the server: its candidate on staging (the server's RELEASING.md).
5. A failure is a ticket; its fix goes to `main`, then the next candidate `rc.N+1`.

## The release

Once a candidate passed, from the same commits:

1. `npm version X.Y.Z --no-git-tag-version`; `## Unreleased` → `## X.Y.Z — <title>` in
   `CHANGELOG.md`; commit "Release X.Y.Z: …"; tag `vX.Y.Z`; push the commit and the tag.
2. Publish puts the VSIX on the Marketplace and Open VSX with a GitHub release, and the packages
   on npm's `latest` (Trusted Publishing; see the workflow's header).
3. The server takes the packages (`X.Y.Z`) and is released after it (the server's RELEASING.md).
4. Close the tickets; update the knowledge base's feature map.
