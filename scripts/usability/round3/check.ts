// Round 3's checks (AFD-99): what the session achieved, from the workspace, the run audit, the runs'
// events and the typed answers. pass: done as asked; fail: not done, or no answer; review: an
// answer or a result the check could not match with confidence, for the analyst. Never a judgement
// of the participant.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatedState } from '../../../src/core/engine/files';
import { registerName } from '../../../src/core/flow/dataNames';
import { next, reads, runEvents, sameMode, text } from '../flowChecks';
import type { SessionDirs } from '../study';
import {
  type Check,
  endOf,
  hostMentioned,
  level,
  mentions,
  mentionsAny,
  node,
  read,
  audit as runAudit,
  runs,
  type Verdict,
} from '../verify';
import { C } from './data';

const SECURITY = 'flows/security';
const PLATFORM = 'flows/platform';

export function checkRound3(dirs: SessionDirs, answers: Record<string, string>): Check[] {
  const checks: Check[] = [];
  const add = (task: string, verdict: Verdict, detail: string) =>
    checks.push({ task, verdict, detail });
  const at = (dir: string, key: string) => read(join(dirs.workspace, dir, `${key}.flow.yaml`));
  const baseline = at(SECURITY, C.baseline.key);
  const deploy = at(SECURITY, C.deploy.key);
  const backup = at(PLATFORM, C.backup.key);
  const health = at(SECURITY, C.health.key);
  const rollout = at(SECURITY, C.rollout.key);
  const upgrade = at(SECURITY, C.upgrade.key);
  const rotation = at(PLATFORM, C.rotation.key);
  const ans = (id: string) => answers[id] ?? '';

  // T1: check -> the new step -> the banner, and the new step's failed hosts end in a failed end.
  {
    const b = C.baseline;
    const check = baseline && node(baseline, b.check.key);
    const added = baseline && check && next(baseline, check, 'ok_hosts');
    const then = baseline && added && next(baseline, added, 'ok_hosts');
    const lv = baseline && level(baseline);
    const stop = lv && added && endOf(lv, added.id, 'failed_hosts');
    const inPlace = added?.type === 'task' && mentions(added.title, b.insert);
    const ok = inPlace && then?.key === b.banner.key && stop?.outcome === 'failed';
    add(
      'T1',
      ok ? 'pass' : 'fail',
      added
        ? `after ${b.check.title}: "${added.title}", then "${then?.title ?? 'nothing'}"; its failed hosts ${stop ? `reach "${stop.title}" (${stop.outcome})` : 'go nowhere'}`
        : 'no step after the check',
    );
  }

  // T2: copy with content, dest, owner and mode.
  {
    const want = C.baseline.bind;
    const impl = baseline && node(baseline, C.baseline.banner.key)?.impl;
    const p = impl?.params ?? {};
    const okModule = impl?.kind === 'module' && /(^|\.)copy$/.test(impl.ref ?? '');
    const wrong = Object.entries(want.params).filter(([k, x]) =>
      k === 'mode' ? !sameMode(p[k], x) : text(p[k]) !== x,
    );
    add(
      'T2',
      okModule && wrong.length === 0 ? 'pass' : 'fail',
      impl
        ? `${impl.ref} ${JSON.stringify(p)}${wrong.length ? `; not as asked: ${wrong.map(([k]) => k).join(', ')}` : ''}`
        : 'not bound',
    );
  }

  // T3: mode 0600, no backup, src and dest as they were.
  {
    const s = C.deploy.push;
    const p = (deploy && node(deploy, s.key)?.impl?.params) ?? {};
    const mode = sameMode(p.mode, C.deploy.mode);
    const noBackup = p.backup === undefined || p.backup === false || text(p.backup) === 'false';
    const kept = text(p.src) === s.params.src && text(p.dest) === s.params.dest;
    add(
      'T3',
      mode && noBackup && kept ? 'pass' : 'fail',
      `mode ${text(p.mode) || 'none'}, backup ${text(p.backup) || 'none'}, src and dest ${kept ? 'kept' : 'changed'}`,
    );
  }

  // T4: the report reads an input from the version step, and its message uses it.
  {
    const report = deploy && node(deploy, C.deploy.report.key);
    const from = Object.entries(report?.inputs ?? {}).filter(([, f]) =>
      (f?.from ?? '').startsWith(`${C.deploy.read.key}.`),
    );
    const msg = report?.impl?.params?.msg;
    const used = from.find(([name]) => reads(msg, name));
    add(
      'T4',
      used ? 'pass' : from.length || reads(msg, 'read_version_result') ? 'review' : 'fail',
      `inputs from ${C.deploy.read.key}: ${from.map(([n, f]) => `${n} (${f?.from})`).join(', ') || 'none'}; msg "${text(msg)}"`,
    );
  }

  // T5: a required flow input with the description; the upload's url reads it through an input.
  {
    const k = C.backup;
    const flowInputs = Object.entries(backup?.flow?.inputs ?? {}).filter(([, f]) => !f?.targets);
    const described = flowInputs.find(([, f]) => mentions(f?.description ?? '', k.description));
    const upload = backup && node(backup, k.upload.key);
    const url = upload?.impl?.params?.url;
    const via = Object.entries(upload?.inputs ?? {}).find(
      ([name, f]) => described && f?.from === `flow.${described[0]}` && reads(url, name),
    );
    const required = described?.[1]?.required === true;
    add(
      'T5',
      described && via && required ? 'pass' : described || via ? 'review' : 'fail',
      `flow inputs: ${flowInputs.map(([n, f]) => `${n}${f?.required ? ' (required)' : ''}: "${f?.description ?? ''}"`).join('; ') || 'none'}; url "${text(url)}"`,
    );
  }

  // T6: retries 10, delay 15, until reads the result and tests for "installed".
  {
    const d = C.deploy;
    const wait = deploy && node(deploy, d.wait.key);
    const s = wait?.settings ?? {};
    const until = String(s.until ?? '').trim();
    const result = wait ? registerName(wait) : '';
    const okUntil = until.includes(d.until) && new RegExp(`\\b${result}\\b`).test(until);
    add(
      'T6',
      s.retries === d.retries && s.delay === d.delay && okUntil
        ? 'pass'
        : s.retries === d.retries && s.delay === d.delay && until
          ? 'review'
          : 'fail',
      `retries ${s.retries ?? 'none'}, delay ${s.delay ?? 'none'}, until "${until}" (result ${result})`,
    );
  }

  // T7: the subflow goes one host at a time.
  {
    const sub = upgrade && node(upgrade, 'upgrade');
    const rolling = sub?.settings?.rolling;
    add(
      'T7',
      text(rolling) === '1' ? 'pass' : 'fail',
      `rolling ${rolling ?? 'none'}, serial ${sub?.settings?.serial ?? 'none'}`,
    );
  }

  // T8: become as svc-backup, and no_log.
  {
    const k = C.backup;
    const step = backup && node(backup, k.readKey.key);
    const kw = (step?.impl?.keywords ?? {}) as Record<string, unknown>;
    const user = text(step?.settings?.become_user ?? kw.become_user);
    const become = step?.settings?.become === true;
    const noLog = kw.no_log === true || ['true', 'yes'].includes(text(kw.no_log).toLowerCase());
    add(
      'T8',
      become && user === k.user && noLog ? 'pass' : 'fail',
      `become ${become}, user ${user || 'none'}, no_log ${text(kw.no_log) || 'none'}`,
    );
  }

  // T9: a loop over the three zones; the command reads the loop variable instead of ZONE.
  {
    const k = C.backup;
    const step = backup && node(backup, k.exportZones.key);
    const kw = (step?.impl?.keywords ?? {}) as Record<string, unknown>;
    const loop = kw.loop ?? kw.with_items ?? kw.with_list;
    const items = Array.isArray(loop) ? loop.map(text) : text(loop).split(/[^a-z]+/i);
    const zones = k.zones.every((z) => items.includes(z));
    const loopVar = text(
      (kw.loop_control as Record<string, unknown> | undefined)?.loop_var ?? 'item',
    );
    const cmd = step?.impl?.params?.cmd;
    const okCmd = reads(cmd, loopVar) && !text(cmd).includes('ZONE');
    add(
      'T9',
      zones && okCmd ? 'pass' : loop ? 'review' : 'fail',
      `loop ${JSON.stringify(loop ?? null)}; cmd "${text(cmd)}"`,
    );
  }

  const entries = runAudit(dirs.storage);
  // T10: a finished check run on the south site only; the answer names both failing pairs there.
  {
    const h = C.health;
    const south = new Set(C.groups[C.site]);
    const checksRun = runs(entries, h.key, 'check').filter((r) => r.finish);
    const onSouth = checksRun.find((r) => {
      const { hosts } = runEvents(dirs.storage, health?.flow?.id, r.launch.run);
      return hosts.size > 0 ? [...hosts].every((x) => south.has(x)) : r.launch.hosts === south.size;
    });
    const a = ans('T10');
    const pairs = [h.first, h.second].filter(
      (s) => hostMentioned(a, s.fails) && mentionsAny(a, s.title),
    );
    const north = hostMentioned(a, C.north);
    const verdict: Verdict = !checksRun.length
      ? 'fail'
      : !onSouth
        ? 'fail'
        : pairs.length === 2 && !north
          ? 'pass'
          : 'review';
    add(
      'T10',
      verdict,
      `${checksRun.length} finished check run(s), on ${checksRun.map((r) => r.launch.hosts).join(', ') || 'none'} hosts; ${onSouth ? 'one on the south site only' : 'none on the south site only'}; answer names ${pairs.length} of 2 pairs${north ? `, and ${C.north}` : ''}`,
    );
  }

  // T11: a real run on all six that finished clean, with the ticket's three values in its output.
  {
    const want = Object.values(C.rollout.inputs).map((f) => f.value);
    const real = runs(entries, C.rollout.key, 'real').filter((r) => r.finish);
    const good = real.find((r) => {
      const { raw } = runEvents(dirs.storage, rollout?.flow?.id, r.launch.run);
      return (
        r.launch.hosts === C.hosts.length &&
        r.finish?.rc === 0 &&
        r.finish.failed === 0 &&
        want.every((x) => raw.includes(x))
      );
    });
    add(
      'T11',
      good ? 'pass' : 'fail',
      real.length
        ? real
            .map((r) => {
              const { raw } = runEvents(dirs.storage, rollout?.flow?.id, r.launch.run);
              const missing = want.filter((x) => !raw.includes(x));
              return `hosts ${r.launch.hosts}, rc ${r.finish?.rc}, failed ${r.finish?.failed}${missing.length ? `, missing ${missing.join(', ')}` : ''}`;
            })
            .join('; ')
        : 'no finished real run',
    );
  }

  // T12: the host, where it ended and where it was expected, by title or key, and why.
  {
    const h = C.health;
    const a = ans('T12');
    const said = [
      hostMentioned(a, h.second.fails),
      mentions(a, 'stopped'),
      mentionsAny(a, h.reported) || mentions(a, 'reported'),
      /\bha\b|\bpeer\b|\bsync\b|\bpair\b/i.test(a),
    ];
    add(
      'T12',
      said.every(Boolean) ? 'pass' : a.trim() ? 'review' : 'fail',
      `answer names ${said.filter(Boolean).length} of 4: host, Stopped, ${h.reported}, the HA step`,
    );
  }

  // T13: the broken flow and the flow whose code was edited by hand.
  {
    const named = [C.audit.name, C.rotation.name].filter((n) => mentions(ans('T13'), n));
    add(
      'T13',
      named.length === 2 ? 'pass' : ans('T13').trim() ? 'review' : 'fail',
      `named ${named.length} of 2 flows`,
    );
  }

  // T14: the flow says 30 days, and the playbook is the designer's again with the fix.
  {
    const r = C.rotation;
    const age = rotation && node(rotation, r.find.key)?.impl?.params?.age;
    const file = join(dirs.workspace, PLATFORM, 'generated', `${r.key}.yml`);
    const code = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const state = code ? generatedState(code) : undefined;
    const fixed = code.includes(r.handEdit.to);
    const ok = text(age) === r.age && state?.ours && !state.edited && fixed;
    add(
      'T14',
      ok ? 'pass' : 'fail',
      `flow age ${text(age) || 'none'}; playbook ${!state ? 'missing' : state.edited ? 'edited by hand' : "the designer's"}, ${fixed ? 'keeps 30d' : 'without 30d'}`,
    );
  }

  // T15: the step that needs root keeps become with an accepted finding; the other loses become.
  {
    const u = C.upgrade;
    const sub = (key: string) => u.subflows.find((s) => s.steps.some((x) => x.key === key))?.key;
    const root = upgrade && node(upgrade, `${sub(u.needsRoot)}/${u.needsRoot}`);
    const noRoot = upgrade && node(upgrade, `${sub(u.noRoot)}/${u.noRoot}`);
    const accepted = (upgrade?.decisions ?? []).find(
      (d) =>
        'finding' in d &&
        typeof d.finding === 'string' &&
        root !== undefined &&
        d.finding.includes(`become:${root.id}`) &&
        (d.reason ?? '').trim().length > 0,
    );
    const a = Boolean(root?.settings?.become && accepted);
    const b = Boolean(noRoot && !noRoot.settings?.become);
    add(
      'T15',
      a && b ? 'pass' : 'fail',
      `${root?.title}: become ${Boolean(root?.settings?.become)}, accepted ${accepted ? `("${accepted.reason}")` : 'no'}; ${noRoot?.title}: become ${Boolean(noRoot?.settings?.become)}`,
    );
  }

  // T16: the added step, the renamed one (new or old title) and the rebound one.
  {
    const o = C.outside;
    const a = ans('T16');
    const said = (x: string) => mentions(a, x.replace(/^(Check|Verify|Copy) /, ''));
    const n = [
      said(o.added.title),
      said(o.renamed.title) || said(o.renamed.was),
      said(o.rebound.title),
    ].filter(Boolean).length;
    add('T16', n === 3 ? 'pass' : a.trim() ? 'review' : 'fail', `answer names ${n} of 3 changes`);
  }
  return checks;
}
