// AFD-117: the MCP server reads the run environment from the workspace's .vscode/settings.json
// (flat keys), with the designer's own rule (resolveEnvironment).
import { describe, expect, it } from 'vitest';
import { resolveEnvironment, settingsFromJson } from '../../../src/core/run/environment';

describe('environment from settings.json (AFD-117)', () => {
  it('reads afd.environment.* and falls back to redhat.ansible, as the designer does', () => {
    const own = settingsFromJson({
      'afd.environment.image': 'ghcr.io/example/netops-ee:2.19',
      'afd.environment.containerEngine': 'podman',
      'afd.environment.containerOptions': ['--network=host'],
    });
    expect(resolveEnvironment(own.afd, own.redhat, 'linux')).toEqual({
      ok: true,
      env: {
        kind: 'container',
        engine: 'podman',
        image: 'ghcr.io/example/netops-ee:2.19',
        options: ['--network=host'],
        mounts: [],
        source: 'afd',
        label: 'podman: ghcr.io/example/netops-ee:2.19',
      },
    });
    const redhat = settingsFromJson({
      'ansible.executionEnvironment.enabled': true,
      'ansible.executionEnvironment.image': 'quay.io/example/ee:latest',
    });
    expect(resolveEnvironment(redhat.afd, redhat.redhat, 'linux')).toMatchObject({
      ok: true,
      env: { kind: 'container', image: 'quay.io/example/ee:latest', source: 'redhat.ansible' },
    });
    // A value of the wrong type is the default.
    expect(settingsFromJson({ 'afd.environment.kind': 7 }).afd.kind).toBe('auto');
    expect(resolveEnvironment(settingsFromJson({}).afd, {}, 'win32').ok).toBe(false);
  });
});
