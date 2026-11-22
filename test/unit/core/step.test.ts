// AFD-346: what the step events of a run say (ADR-0039).
import { describe, expect, it } from 'vitest';
import { runProcess } from '../../../src/core/run/command';
import {
  answer,
  pausedLine,
  STEP_NOT_ON_AWX,
  startControl,
  stepEvent,
  stepRefusal,
  stepState,
  stoppedLine,
} from '../../../src/core/run/step';

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

  it("keeps the repository's strategy folders before ours, and names the step a segment starts in", () => {
    const spec = runProcess(
      { kind: 'local', python: 'python3' } as never,
      paths,
      {
        ...base,
        callbacks: {
          enabled: [],
          paths: [],
          plugins: { strategy_plugins: ['/repo/plugins/strategy', 'bad:path'] },
        },
        step: { timeoutS: 60, inside: '01JAPPROVAL0000000000000000' },
      },
      'n',
    );
    const list = spec.env.ANSIBLE_STRATEGY_PLUGINS?.split(':') ?? [];
    expect(list[0]).toBe('/repo/plugins/strategy');
    expect(list.at(-1)).toMatch(/strategy_plugins$/);
    expect(list).not.toContain('bad');
    expect(spec.env.AFD_STEP_INSIDE).toBe('01JAPPROVAL0000000000000000');
    // A node id that is not one is never passed on.
    const odd = runProcess(
      { kind: 'local', python: 'python3' } as never,
      paths,
      { ...base, step: { timeoutS: 60, inside: 'x; rm -rf /' } },
      'n',
    );
    expect(odd.env.AFD_STEP_INSIDE).toBeUndefined();
  });
});

describe('step words', () => {
  const p = {
    id: 't-1',
    node: 'n',
    play: '[x] X',
    hosts: ['a', 'b', 'c'],
    since: 1000,
    timeout: 3600,
  };

  it('a step event line is read, other lines are not', () => {
    expect(stepEvent(JSON.stringify({ event: 'pause', id: 't-1' }))).toMatchObject({ id: 't-1' });
    expect(stepEvent(JSON.stringify({ event: 'result', msg: 'pause' }))).toBeUndefined();
    expect(stepEvent('{"event":"pause",')).toBeUndefined();
  });

  it('says where the run waits and when it stops by itself', () => {
    expect(pausedLine(p, 'Ping', 1000_000 + 60_000)).toBe(
      'Paused before Ping · 3 hosts · stops by itself in 59 min',
    );
    expect(pausedLine({ ...p, hosts: ['a'] }, 'Ping', (1000 + 3590) * 1000)).toBe(
      'Paused before Ping · 1 host · stops by itself in 10 s',
    );
  });

  it('says why a run stopped', () => {
    const stopped = { node: 'n', hosts: ['a'], reason: 'timeout' as const };
    expect(stoppedLine(stopped, 'Ping', 3600)).toBe(
      'Stopped before Ping: nobody answered for 60 minutes',
    );
    expect(stoppedLine({ ...stopped, reason: 'driver' }, 'Ping', 3600)).toBe('Stopped before Ping');
  });

  it('AWX cannot run step by step; here and the server can', () => {
    expect(stepRefusal('awx')).toBe(STEP_NOT_ON_AWX);
    expect(stepRefusal('local')).toBeUndefined();
    expect(stepRefusal('runner')).toBeUndefined();
  });
});
