// AFD-115: the live scenario check: problems, simulated verdicts, and Ansible verdicts that go out
// of date when the flow's routing or the scenario changes (not when a status or a position does).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { routingDesign } from '../../../src/core/flow/semantic';
import type { FlowDocument } from '../../../src/core/flow/types';
import { checkLive, checkSummary, storedVerdict } from '../../../src/core/scenario/live';
import { parseScenarios, type Scenario } from '../../../src/core/scenario/scenarios';

const FIX = join(__dirname, '../../fixtures/engine');
const DOC = parse(readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8')) as FlowDocument;
const TEXT = readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8');
const FIRST = (parseScenarios(TEXT).file?.scenarios[0] ?? {}) as Scenario;

describe('the live scenario check (AFD-115)', () => {
  it('simulates every scenario of a file that fits', () => {
    const c = checkLive(DOC, TEXT);
    expect(c.file).toBe(true);
    expect(c.problems).toEqual([]);
    expect(c.names).toHaveLength(3);
    expect(c.results.map((r) => [r.passed, r.engine])).toEqual([
      [true, 'simulated'],
      [true, 'simulated'],
      [true, 'simulated'],
    ]);
    expect(checkSummary(c)).toBe('Scenarios: 3 pass (simulated)');
  });

  it('says a host ends elsewhere, and simulates nothing while the file has errors', () => {
    const wrong = TEXT.replace('h03: gate.failed_hosts', 'h03: done');
    const c = checkLive(DOC, wrong);
    expect(c.results[2]?.hosts.find((h) => h.host === 'h03')).toEqual({
      host: 'h03',
      expected: 'done',
      actual: 'gate.failed_hosts',
    });
    expect(checkSummary(c)).toBe('Scenarios: 1 of 3 failing (simulated)');
    const broken = checkLive(DOC, TEXT.replace('stage/prepare:', 'nowhere:'));
    expect(broken.problems.map((p) => p.message)).toContain(
      'No step nowhere: use a key, or sub/step inside a subflow',
    );
    expect(broken.results).toEqual([]);
    expect(checkSummary(broken)).toBe('Scenarios: the file does not fit the flow');
    expect(checkLive(DOC, 'scenarios: [').error).toBeDefined();
    expect(checkLive(DOC, undefined)).toEqual({
      file: false,
      problems: [],
      names: [],
      scenarios: [],
      results: [],
      verified: {},
    });
  });

  it('keeps an Ansible verdict current until the routing or the scenario changes', () => {
    const result = checkLive(DOC, TEXT).results[0];
    if (!result) throw new Error('no result');
    const stored = {
      [FIRST.name]: storedVerdict(
        DOC,
        FIRST,
        { ...result, engine: 'ansible' },
        '2026-11-07T21:00:00Z',
      ),
    };
    expect(checkLive(DOC, TEXT, stored).verified[FIRST.name]?.stale).toBe(false);
    // A status, a position or a note is no routing change.
    const moved = structuredClone(DOC);
    (moved.nodes[3] as { status?: string }).status = 'implemented';
    expect(routingDesign(moved)).toBe(routingDesign(DOC));
    expect(checkLive(moved, TEXT, stored).verified[FIRST.name]?.stale).toBe(false);
    // A wire moved is.
    const rewired = structuredClone(DOC);
    const edge = rewired.edges?.find((e) => e.from.port === 'failed_hosts');
    if (edge) edge.from.port = 'ok_hosts';
    expect(checkLive(rewired, TEXT, stored).verified[FIRST.name]?.stale).toBe(true);
    // So is the scenario itself, but not another one.
    const edited = TEXT.replace(
      '      h02: done\n  - name: hosts as',
      '      h02: failed\n  - name: hosts as',
    );
    expect(checkLive(DOC, edited, stored).verified[FIRST.name]?.stale).toBe(true);
    // A verdict for a scenario no longer in the file is not shown.
    expect(checkLive(DOC, TEXT.replace(FIRST.name, 'renamed'), stored).verified).toEqual({});
  });
});
