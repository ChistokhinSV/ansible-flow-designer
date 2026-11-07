// AFD-114: the simulator on seeded random flows (test/shared/flowFuzz.ts). Properties that hold
// whatever the flow: groups map to ports, a host leaves each step it runs, rolling batches do not
// move a host's end, and it stays fast. Where hosts go is held to Ansible by the engine suite.
import { describe, expect, it } from 'vitest';
import type { PlanStep } from '../../../src/core/engine/types';
import type { FlowDocument } from '../../../src/core/flow/types';
import { hostEnds } from '../../../src/core/scenario/scenarios';
import { prepare, simulateRun } from '../../../src/core/scenario/simulate';
import { fuzzFlow, fuzzScenario } from '../../shared/flowFuzz';
import { simulateCases } from '../../shared/simulateCases';

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

/** The hosts a step runs on, from the groups the run left (a step's inputs fill before it runs). */
function stepHosts(step: PlanStep, start: string[], groups: Record<string, string[]>): string[] {
  const set = new Set<string>();
  for (const t of step.hosts)
    for (const h of 'start' in t ? start : (groups[t.group] ?? [])) set.add(h);
  return [...set];
}

function unrolled(doc: FlowDocument): FlowDocument {
  const copy = structuredClone(doc);
  for (const n of copy.nodes) if (n.settings?.rolling !== undefined) delete n.settings.rolling;
  return copy;
}

describe('the simulator on random flows (AFD-114)', () => {
  it('fills only groups that map to a port, and every host leaves each step it runs', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const doc = fuzzFlow(seed);
      const build = prepare(doc);
      expect(build.ok, `seed ${seed}`).toBe(true);
      const s = fuzzScenario(doc, seed);
      const sim = simulateRun(doc, s);
      const groups = sim.groups ?? {};
      for (const g of Object.keys(groups))
        expect(build.routes[g], `seed ${seed} ${g}`).toBeDefined();
      if (sim.summary?.stoppedEarly) continue;
      const start = s.inputs?.devices as string[];
      for (const step of build.plan?.steps ?? []) {
        if (step.kind === 'target') continue;
        const outs = Object.entries(step.ports)
          .filter(([port]) => port !== 'always')
          .map(([, g]) => new Set(groups[g] ?? []));
        // A join's `all` with no failed_hosts port keeps the hosts that miss a branch.
        const keeps = step.kind === 'join' && step.mode === 'all' && !step.ports.failed_hosts;
        for (const h of stepHosts(step, start, groups)) {
          if (keeps) continue;
          expect(
            outs.some((o) => o.has(h)),
            `seed ${seed}: ${h} left ${step.key}`,
          ).toBe(true);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('ends every host where it ends without rolling batches', () => {
    let rolled = 0;
    for (const seed of SEEDS) {
      const doc = fuzzFlow(seed);
      if (!doc.nodes.some((n) => n.settings?.rolling !== undefined)) continue;
      const s = fuzzScenario(doc, seed);
      const a = simulateRun(doc, s);
      if (a.needsAnsible.length) continue;
      const flat = unrolled(doc);
      const b = simulateRun(flat, s);
      if (!a.summary || !b.summary) throw new Error(`seed ${seed}`);
      expect(hostEnds(doc, a.summary), `seed ${seed}`).toEqual(hostEnds(flat, b.summary));
      expect(a.summary.outcome).toEqual(b.summary.outcome);
      rolled++;
    }
    expect(rolled).toBeGreaterThan(10);
  });

  it('generates every case the engine suite runs, and models nearly all of them', () => {
    const cases = simulateCases();
    const flagged = cases.filter((c) => {
      const sim = simulateRun(c.doc, c.s);
      expect(prepare(c.doc).ok, c.name).toBe(true);
      // A playbook with no play would test nothing (fixtures written by key need their IDs).
      expect(prepare(c.doc).plan?.steps.length, c.name).toBeGreaterThan(0);
      expect(sim.summary, c.name).toBeDefined();
      return sim.needsAnsible.length > 0;
    });
    expect(cases.length).toBeGreaterThan(100);
    expect(flagged.length / cases.length, flagged.map((c) => c.name).join(', ')).toBeLessThan(0.15);
  });

  it('takes under 10 ms for 200 steps and 50 hosts', () => {
    const doc = fuzzFlow(7, 200);
    const s = fuzzScenario(doc, 7);
    s.inputs = { devices: Array.from({ length: 50 }, (_, i) => `h${i + 1}`) };
    simulateRun(doc, s);
    expect(prepare(doc).plan?.steps.length).toBeGreaterThan(150);
    // The best of 20: the suite runs files side by side, and a busy moment is not the simulator.
    const times = Array.from({ length: 20 }, () => {
      const t = performance.now();
      simulateRun(doc, s);
      return performance.now() - t;
    });
    expect(Math.min(...times)).toBeLessThan(10);
  });
});
