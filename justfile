# Ansible Flow Designer task runner. Every build, test and dev-server command goes through here.
set windows-shell := ["pwsh.exe", "-NoLogo", "-NoProfile", "-Command"]
set shell := ["bash", "-cu"]

# List recipes
default:
    @just --list

# Install exact dependencies from package-lock.json
install:
    npm ci --no-fund --no-audit

# Development build: extension host (esbuild) + webview (Vite)
build:
    node scripts/build.mjs

# Production build (minified, no sourcemaps); what the VSIX ships
build-prod:
    node scripts/build.mjs --production

# Rebuild on change (extension + webview)
watch:
    node scripts/build.mjs --watch

# Type-check (TypeScript 7) and lint/format check (Biome)
check:
    npx --no-install tsc -p tsconfig.json
    npx --no-install tsc -p tsconfig.webview.json
    npx --no-install biome check .

# Apply Biome formatting and safe lint fixes
fmt:
    npx --no-install biome check --write .

# Unit and component tests (Vitest); extra args go to vitest, e.g. `just test core`
test *args:
    npx --no-install vitest run {{ args }}

# Integration tests inside VS Code (version: stable | insiders | 1.140.0)
test-int $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label integration

# Performance suite on the production bundle (timings reported by the webview)
perf $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label perf

# The Red Hat YAML extension validates flows with our schema, not SchemaStore's (AFD-5; installs it)
test-yaml $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label yaml

# Run mode against the lab AWX (M7): AFD_AWX_* from the environment or .env, the tunnel to AWX open
test-awx $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label m7

# Lenses inside VS Code (M8); the inventory test runs when AFD_TEST_IMAGE is set
test-lens $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label m8

# Extract into subflow inside VS Code (AFD-7)
test-extract $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label extract

# Copy and paste of nodes inside VS Code (AFD-17); the system clipboard is restored afterwards
test-clipboard $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label clipboard

# AWX workflow import inside VS Code (M9); the skeleton run needs AFD_TEST_IMAGE, the API import AFD_AWX_URL/TOKEN
test-import $AFD_VSCODE_VERSION="stable": build-prod
    node scripts/build.mjs --tests
    npx --no-install vscode-test --label m9

# Engine, probe and Docker integration suites in a throwaway container on the GNS3 VM (M7, lab/README.md)
test-docker-lab *suites:
    node lab/docker-suites.mjs {{ suites }}

# Engine contract tests: generated code runs in each Ansible image (Docker); images comma-separated
test-engine $AFD_ENGINE_IMAGES="ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21":
    {{ if os_family() == "windows" { "$env:AFD_ENGINE='1';" } else { "export AFD_ENGINE=1;" } }} npx --no-install vitest run --project engine

# Catalog search gates (19/20 intents in the top 5, p95 < 50 ms) on a catalog dump folder
test-catalog dir:
    {{ if os_family() == "windows" { "$env:AFD_CATALOG_DIR='" + dir + "';" } else { "export AFD_CATALOG_DIR='" + dir + "';" } }} npx --no-install vitest run --project catalog

# Probe contract tests (pytest, Docker) in the Ansible images; images comma-separated
probe-test $AFD_PROBE_IMAGES="ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21":
    cd probe && uv run pytest -q

# Build the minimal execution environment image afd-ee:<core> (e.g. just ee-build 2.20)
ee-build core="2.19":
    docker build -f docker/afd-ee.Dockerfile --build-arg ANSIBLE_CORE={{ core }} -t afd-ee:{{ core }} docker

# AWX execution environment afd-awx-ee:<core> (afd-ee + ansible-runner) for Run mode in the lab (M7)
awx-ee-build core="2.19": (ee-build core)
    docker build -f docker/afd-awx-ee.Dockerfile --build-arg CORE={{ core }} -t afd-awx-ee:{{ core }} docker

# Generate Option A code for flows into generated/ next to each (--check, --simulate, --out DIR)
codegen *args:
    npx --no-install esbuild src/cli/codegen.ts --bundle --platform=node --format=cjs --outfile=out/cli/codegen.cjs --log-level=warning
    node out/cli/codegen.cjs {{ args }}

# Vite dev server for the webview harness (fake host, theme switcher) on http://localhost:5178
harness:
    npx --no-install vite --config vite.config.mts --mode harness

# Package the VSIX into out/ (vsce runs the production build through vscode:prepublish)
package:
    npx --no-install vsce package --no-dependencies --out out/

# Remove build outputs
[windows]
clean:
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue dist, out

[unix]
clean:
    rm -rf dist out

# AWX objects for the GNS3 lab (M7): EE, project, inventory; --sync also updates the project
awx-lab *args:
    npx --no-install esbuild src/cli/awx-lab.ts --bundle --platform=node --format=cjs --outfile=out/cli/awx-lab.cjs --log-level=warning
    node out/cli/awx-lab.cjs {{ args }}
