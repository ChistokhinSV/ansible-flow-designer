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
