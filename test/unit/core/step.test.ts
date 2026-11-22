// AFD-346: what the step events of a run say (ADR-0039).
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../../src/core/run/command';
import { answer, startControl, stepState } from '../../../src/core/run/step';

const pause = (id: string, node: string, hosts: string[]) => ({
  event: 'pause',
  id,
  node,
  play: `[${node}] Step`,
  hosts,
  timeout: 60,
  ts: 10,
});

describe('stepState', () => {
  it('is paused from a pause event to its resume', () => {
    const events: Record<string, unknown>[] = [
      { event: 'play', node: 'a' },
      pause('t-1', 'a', ['h1', 'h2']),
    ];
    expect(stepState(events).paused).toMatchObject({ id: 't-1', node: 'a', hosts: ['h1', 'h2'] });
    events.push({ event: 'resume', id: 't-1', command: 'step' });
    expect(stepState(events)).toEqual({ pauses: 1 });
  });

  it('a resume of another pause leaves the run paused', () => {
    const s = stepState([pause('t-2', 'b', ['h1']), { event: 'resume', id: 't-1' }]);
    expect(s.paused?.id).toBe('t-2');
  });

  it('stopped: where and why, not paused any more', () => {
    const s = stepState([
      pause('t-1', 'a', ['h1']),
      { event: 'stopped', id: 't-1', node: 'a', hosts: ['h1'], reason: 'timeout' },
    ]);
    expect(s).toEqual({ pauses: 1, stopped: { node: 'a', hosts: ['h1'], reason: 'timeout' } });
  });

  it('the end of the run (stats) ends a pause a killed process left behind', () => {
    expect(stepState([pause('t-1', 'a', ['h1']), { event: 'stats' }]).paused).toBeUndefined();
  });
});

describe('control', () => {
  it('a step-by-step run starts with step; pause points alone with continue', () => {
    expect(startControl(true)).toEqual({ v: 1, command: 'step', points: [], reply: null });
    expect(startControl(false, ['n1']).command).toBe('continue');
    expect(answer('stop', ['n1'], 't-3')).toEqual({
      v: 1,
      command: 'stop',
      points: ['n1'],
      reply: 't-3',
    });
  });
});

describe('runProcess for a step-by-step run', () => {
  const base = {
    playbook: 'g/x.yml',
    check: false,
    runDir: 'C:/runs/r1',
    vault: false,
    hasConfig: false,
  };
  const paths = { root: 'C:/repo', probe: 'C:/ext/probe' };

  it('sets no strategy variable unless asked: every other run is as before', () => {
    const env = runProcess({ kind: 'local', python: 'python3' } as never, paths, base, 'n').env;
    expect(Object.keys(env).filter((k) => /STRATEGY|AFD_STEP/.test(k))).toEqual([]);
  });

  it('names our strategy and the control file as the environment sees them', () => {
    const spec = runProcess(
      { kind: 'wsl', distro: 'Debian', label: 'wsl' },
      paths,
      { ...base, step: { timeoutS: 900 } },
      'n',
    );
    const args = spec.args.join(' ');
    expect(args).toContain('ANSIBLE_STRATEGY=afd_step');
    expect(args).toContain('ANSIBLE_STRATEGY_PLUGINS=/mnt/c/ext/probe/strategy_plugins');
    expect(args).toContain('AFD_STEP_CONTROL=/mnt/c/runs/r1/control.json');
    expect(args).toContain('AFD_STEP_TIMEOUT=900');
    const container = runProcess(
      {
        kind: 'container',
        engine: 'docker',
        image: 'afd-ee:2.21',
        options: [],
        mounts: [],
        source: 'afd',
        label: 'c',
      },
      paths,
      { ...base, step: { timeoutS: 900 } },
      'n',
    );
    expect(container.args).toContain('AFD_STEP_CONTROL=/afd-run/control.json');
    expect(container.args).toContain('ANSIBLE_STRATEGY_PLUGINS=/afd/strategy_plugins');
  });
});
