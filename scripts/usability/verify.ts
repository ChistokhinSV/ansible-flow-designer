// Checks what a usability session achieved (AFD-78), from the workspace, the extension's run audit
// and the typed answers. pass: done as asked; fail: not done; review: a typed answer the check could
// not match with confidence, for the analyst to read. Never a judgement of the participant.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import type { FlowDocument, FlowNode } from '../../src/core/flow/types';
import { pipelineLayout, type Variant } from './variants';

export type Verdict = 'pass' | 'fail' | 'review';
export interface Check {
  task: string;
  verdict: Verdict;
  detail: string;
}

type Pos = { x: number; y: number };

interface Level {
  nodes: FlowNode[];
  edges: FlowDocument['edges'];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** The answer names the thing: every significant word of it appears (case and punctuation aside). */
const mentions = (answer: string, thing: string) => {
  const a = ` ${words(answer)} `;
  const sig = words(thing)
    .split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'are', 'all'].includes(w));
  return sig.length > 0 && sig.every((w) => a.includes(` ${w} `) || a.includes(` ${w}s `));
};

/** At least one significant word of the thing appears. */
const mentionsAny = (answer: string, thing: string) => {
  const a = ` ${words(answer)} `;
  return words(thing)
    .split(' ')
    .filter((w) => w.length > 3 && !['check', 'that', 'with'].includes(w))
    .some((w) => a.includes(` ${w} `));
};

/** A host by name, or by its number alone (lab-sw-03: "03" or "3"). */
const hostMentioned = (answer: string, host: string) => {
  const n = /(\d+)$/.exec(host)?.[1];
  return (
    answer.toLowerCase().includes(host) ||
    (n !== undefined && new RegExp(`(^|[^0-9.])0*${Number(n)}([^0-9.]|$)`).test(answer))
  );
};

function read(file: string): FlowDocument | undefined {
  try {
    return parse(readFileSync(file, 'utf8')) as FlowDocument;
  } catch {
    return undefined;
  }
}

function flowFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith('.flow.yaml')) out.push(join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

/** The level a key path names: '' is the top level, 'drain' the inside of subflow drain. */
function level(doc: FlowDocument, path = ''): Level | undefined {
  let lv: Level = { nodes: doc.nodes ?? [], edges: doc.edges ?? [] };
  for (const key of path ? path.split('/') : []) {
    const n = lv.nodes.find((x) => x.key === key);
    if (!n?.subflow) return undefined;
    lv = { nodes: n.subflow.nodes ?? [], edges: n.subflow.edges ?? [] };
  }
  return lv;
}

function node(doc: FlowDocument, path: string): FlowNode | undefined {
  const parts = path.split('/');
  const key = parts.pop() ?? '';
  return level(doc, parts.join('/'))?.nodes.find((n) => n.key === key);
}

/** Follows a port through steps (their ok_hosts) to the end node hosts reach, within 6 hops. */
function endOf(lv: Level, from: string, port: string): FlowNode | undefined {
  let at = { node: from, port };
  for (let i = 0; i < 6; i++) {
    const e = lv.edges.find((x) => x.from.node === at.node && x.from.port === at.port);
    const to = e && lv.nodes.find((n) => n.id === e.to.node);
    if (!to) return undefined;
    if (to.type === 'end') return to;
    at = { node: to.id, port: 'ok_hosts' };
  }
  return undefined;
}

interface AuditEntry {
  event: string;
  run: string;
  mode?: string;
  hosts?: number;
  rc?: number;
  failed?: number;
  flow?: { key: string };
}

function audit(storage: string): AuditEntry[] {
  const file = join(storage, 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

/** Runs of a flow: the launch entry and its finish, if any. */
function runs(entries: AuditEntry[], key: string, mode: string) {
  return entries
    .filter((e) => e.event === 'launch' && e.flow?.key === key && e.mode === mode)
    .map((l) => ({
      launch: l,
      finish: entries.find((e) => e.event === 'finish' && e.run === l.run),
    }));
}

export function verify(
  v: Variant,
  workspace: string,
  storage: string,
  answers: Record<string, string>,
): Check[] {
  const checks: Check[] = [];
  const add = (task: string, verdict: Verdict, detail: string) =>
    checks.push({ task, verdict, detail });
  const at = (file: string) => join(workspace, file);
  const baseline = read(at(`flows/network/${v.baseline.key}.flow.yaml`));
  const upgrade = read(at(`flows/datacenter/${v.upgrade.key}.flow.yaml`));
  const pipeline = read(at(`flows/platform/${v.pipeline.key}.flow.yaml`));
  const ours = new Set(
    [v.baseline, v.health, v.rollout, v.upgrade, v.pipeline, v.audit, v.rotation].map((f) => f.key),
  );

  // T1: a new flow whose top level runs start -> step 1 -> step 2 -> a success end.
  const fresh = flowFiles(workspace)
    .map((f) => ({ f, doc: read(f) }))
    .filter((x) => x.doc && !ours.has(x.doc.flow?.key));
  const t1 = fresh.find(({ doc }) => {
    if (!doc) return false;
    const lv = level(doc);
    const start = lv?.nodes.find((n) => n.type === 'start');
    if (!lv || !start) return false;
    const next = (id: string, port: string) => {
      const e = lv.edges.find((x) => x.from.node === id && x.from.port === port);
      return lv.nodes.find((n) => n.id === e?.to.node);
    };
    const a = next(start.id, 'ok_hosts');
    const b = a && next(a.id, 'ok_hosts');
    const z = b && next(b.id, 'ok_hosts');
    return (
      a?.type === 'task' &&
      b?.type === 'task' &&
      z?.type === 'end' &&
      mentions(a.title, v.first.steps[0]) &&
      mentions(b.title, v.first.steps[1])
    );
  });
  add(
    'T1',
    t1 ? 'pass' : fresh.length ? 'review' : 'fail',
    t1
      ? `${relative(workspace, t1.f)}: both steps in order`
      : fresh.length
        ? `new flow(s) ${fresh.map((x) => relative(workspace, x.f)).join(', ')} without the two steps in order`
        : 'no new flow',
  );

  // T2: the draft step bound to the module with both parameters.
  const draft = baseline && node(baseline, v.baseline.draft.key);
  const impl = draft?.impl;
  const short = (impl?.ref ?? '').replace(/^ansible\.(builtin|legacy)\./, '');
  const want = v.baseline.bind;
  const same = (a: unknown, b: string) =>
    String(a ?? '')
      .trim()
      .replace(/^["']|["']$/g, '') === b;
  const t2 =
    impl?.kind === 'module' &&
    short === want.module.split('.').pop() &&
    Object.entries(want.params).every(([k, x]) => same(impl.params?.[k], x));
  add(
    'T2',
    t2 ? 'pass' : 'fail',
    impl ? `${impl.kind} ${impl.ref} ${JSON.stringify(impl.params ?? {})}` : 'not bound',
  );

  // T3: the check step's failed_hosts end in a failed end (directly or through a pattern's step).
  const lv = baseline && level(baseline);
  const check = baseline && node(baseline, v.baseline.check.key);
  const t3end = lv && check && endOf(lv, check.id, 'failed_hosts');
  add(
    'T3',
    t3end?.outcome === 'failed' ? 'pass' : 'fail',
    t3end ? `failed_hosts reach "${t3end.title}" (${t3end.outcome})` : 'failed_hosts not wired',
  );

  const entries = audit(storage);
  // T4: a check run of the health flow, and the answer names both failing pairs.
  const t4runs = runs(entries, v.health.key, 'check');
  const pairs = [v.health.first, v.health.second];
  const named = pairs.filter(
    (s) => hostMentioned(answers.T4 ?? '', s.fails) && mentionsAny(answers.T4 ?? '', s.title),
  );
  add(
    'T4',
    !t4runs.some((r) => r.finish) ? 'fail' : named.length === 2 ? 'pass' : 'review',
    `${t4runs.length} check run(s); answer names ${named.length} of 2 failing step/host pairs`,
  );

  // T5: a real run of the rollout on all four lab hosts that finished with nothing failed.
  const t5 = runs(entries, v.rollout.key, 'real');
  const ok = t5.find(
    (r) => r.launch.hosts === v.hosts.length && r.finish?.rc === 0 && r.finish.failed === 0,
  );
  add(
    'T5',
    ok ? 'pass' : 'fail',
    t5.length
      ? t5
          .map(
            (r) =>
              `hosts ${r.launch.hosts}, rc ${r.finish?.rc ?? 'none'}, failed ${r.finish?.failed ?? '-'}`,
          )
          .join('; ')
      : 'no real run',
  );

  // T6: every step without a binding and every approval named.
  const inner = v.upgrade.subflows.flatMap((s) => s.steps);
  const drafts = inner.filter((s) => !s.kind && !s.msg).map((s) => s.title);
  const approvals = [v.upgrade.approval, v.upgrade.midApproval.title];
  const t6 = [...drafts, ...approvals].filter((t) => mentions(answers.T6 ?? '', t));
  add(
    'T6',
    t6.length === drafts.length + approvals.length ? 'pass' : 'review',
    `named ${t6.length} of ${drafts.length + approvals.length} (${drafts.length} steps not implemented, ${approvals.length} approvals)`,
  );

  // T7: the broken flow and the flow whose code was edited by hand.
  const t7 = [v.audit.name, v.rotation.name].filter((n) => mentions(answers.T7 ?? '', n));
  add('T7', t7.length === 2 ? 'pass' : 'review', `named ${t7.length} of 2 flows`);

  // T8: the failing scenario's host, where it ended (Stopped) and where it was expected.
  const host = v.health.second.fails;
  const t8 = [
    hostMentioned(answers.T8 ?? '', host),
    mentions(answers.T8 ?? '', 'stopped'),
    mentionsAny(answers.T8 ?? '', v.health.reported),
  ].filter(Boolean);
  add(
    'T8',
    t8.length === 3 ? 'pass' : 'review',
    `answer names ${t8.length} of 3: host, Stopped, ${v.health.reported}`,
  );

  // T9: the step that needs root keeps become with an accepted finding; the other loses become.
  const sub = (key: string) =>
    v.upgrade.subflows.find((s) => s.steps.some((x) => x.key === key))?.key;
  const root = upgrade && node(upgrade, `${sub(v.upgrade.needsRoot)}/${v.upgrade.needsRoot}`);
  const noRoot = upgrade && node(upgrade, `${sub(v.upgrade.noRoot)}/${v.upgrade.noRoot}`);
  const accepted = (upgrade?.decisions ?? []).find(
    (d) =>
      'finding' in d &&
      typeof d.finding === 'string' &&
      root !== undefined &&
      d.finding.includes(`become:${root.id}`) &&
      (d.reason ?? '').trim().length > 0,
  );
  const t9a = Boolean(root?.settings?.become && accepted);
  const t9b = Boolean(noRoot && !noRoot.settings?.become);
  add(
    'T9',
    t9a && t9b ? 'pass' : 'fail',
    `${root?.title}: become ${Boolean(root?.settings?.become)}, accepted ${accepted ? `("${accepted.reason}")` : 'no'}; ${noRoot?.title}: become ${Boolean(noRoot?.settings?.become)}`,
  );

  // T10: the three build steps in one column (or row), evenly spaced; every other node where it was.
  const layout = pipeline?.layout ?? {};
  const pos = (key: string) => {
    const n = pipeline && node(pipeline, key);
    return n ? layout[n.id] : undefined;
  };
  const three = v.pipeline.steps.slice(1, 4).map((s) => pos(s.key));
  let t10 = 'fail' as Verdict;
  let t10d = 'positions missing';
  if (three.every(Boolean)) {
    const [a, b, c] = three as [Pos, Pos, Pos];
    const column = Math.max(a.x, b.x, c.x) - Math.min(a.x, b.x, c.x) <= 2;
    const row = Math.max(a.y, b.y, c.y) - Math.min(a.y, b.y, c.y) <= 2;
    const even = column
      ? Math.abs(b.y - a.y - (c.y - b.y)) <= 2
      : row && Math.abs(b.x - a.x - (c.x - b.x)) <= 2;
    const orig = pipelineLayout(v.pipeline);
    const build = new Set(v.pipeline.steps.slice(1, 4).map((s) => s.key));
    const moved = Object.entries(orig)
      .filter(([k]) => !build.has(k))
      .filter(([k, o]) => {
        const p = pos(k);
        return !p || Math.abs(p.x - o.x) > 1 || Math.abs(p.y - o.y) > 1;
      })
      .map(([k]) => k);
    t10 = (column || row) && even && moved.length === 0 ? 'pass' : 'fail';
    t10d = `${column ? 'column' : row ? 'row' : 'not aligned'}, ${even ? 'even' : 'uneven'} gaps, other nodes moved: ${moved.join(', ') || 'none'}`;
  }
  add('T10', t10, t10d);

  // T11: the answer names what the agent did: the step added, the step renamed, the binding changed.
  const o = v.outside;
  const t11 = [o.added.title, o.renamed.title, o.rebound.title].filter((x) =>
    mentions(answers.T11 ?? '', x.replace(/^(Check|Verify|Copy) /, '')),
  );
  add('T11', t11.length === 3 ? 'pass' : 'review', `answer names ${t11.length} of 3 changes`);
  return checks;
}
