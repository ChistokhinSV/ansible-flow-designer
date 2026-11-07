// Round 4's checks (AFD-109): what the session achieved, from the workspace, the run audit, the
// runs' events and the typed answers. pass: done as asked; fail: not done, or no answer; review: an
// answer or a result the check could not match with confidence, for the analyst. Never a judgement
// of the participant.
import { join } from 'node:path';
import { registerName } from '../../../src/core/flow/dataNames';
import { findAccepted } from '../../../src/core/flow/decisions';
import { comparesWholeResult } from '../../../src/core/flow/until';
import { reads, readsField, runEvents, text } from '../flowChecks';
import type { SessionDirs } from '../study';
import {
  type Check,
  hostMentioned,
  mentions,
  mentionsAny,
  node,
  read,
  audit as runAudit,
  runs,
  type Verdict,
} from '../verify';
import { D } from './data';
import { EDGE } from './workspace';

const truthy = (v: unknown) => v === true || ['true', 'yes'].includes(text(v).toLowerCase());

export function checkRound4(dirs: SessionDirs, answers: Record<string, string>): Check[] {
  const checks: Check[] = [];
  const add = (task: string, verdict: Verdict, detail: string) =>
    checks.push({ task, verdict, detail });
  const at = (dir: string, key: string) => read(join(dirs.workspace, dir, `${key}.flow.yaml`));
  const pool = at(EDGE, D.pool.key);
  const dns = at(EDGE, D.dns.key);
  const upgrade = at(EDGE, D.upgrade.key);
  const ans = (id: string) => answers[id] ?? '';
  const p = D.pool;

  // D1: the broken flow and the flow whose code was edited by hand.
  {
    const named = [D.audit.name, D.renewal.name].filter((n) => mentions(ans('D1'), n));
    add(
      'D1',
      named.length === 2 ? 'pass' : ans('D1').trim() ? 'review' : 'fail',
      `named ${named.length} of 2 flows`,
    );
  }

  // D2: retries 12, delay 10, until reads a field of the result and tests for "drained"; the
  // answer (R2: was the Timing sentence read?) says 30 seconds.
  {
    const wait = pool && node(pool, p.wait.key);
    const s = wait?.settings ?? {};
    const until = String(s.until ?? '').trim();
    const result = wait ? registerName(wait) : '';
    const field = new RegExp(`\\b${result}(\\.|\\[)`).test(until);
    const okUntil = until.includes(p.until) && field && !comparesWholeResult(until, result);
    const counts = s.retries === p.retries && s.delay === p.delay;
    const a = ans('D2');
    const said = new RegExp(`\\b${p.timeoutSeconds}\\b|\\bhalf a minute\\b`, 'i').test(a);
    add(
      'D2',
      counts && okUntil ? 'pass' : counts && until ? 'review' : 'fail',
      `retries ${s.retries ?? 'none'}, delay ${s.delay ?? 'none'}, timeout ${s.timeout ?? 'none'}, until "${until}" (result ${result}); answer ${said ? `says ${p.timeoutSeconds} s` : a.trim() ? 'does not say 30 s' : 'empty'}`,
    );
    add(
      'D2 answer',
      said ? 'pass' : a.trim() ? 'review' : 'fail',
      `one try at most ${p.timeout}: "${a.trim()}"`,
    );
  }

  // D3: no_log on the step that reads the key.
  {
    const kw = (pool && node(pool, p.readKey.key)?.impl?.keywords) ?? {};
    const noLog = truthy((kw as Record<string, unknown>).no_log);
    add(
      'D3',
      noLog ? 'pass' : 'fail',
      `no_log ${text((kw as Record<string, unknown>).no_log) || 'none'}`,
    );
  }

  // D4: a loop over the three members; the command reads the loop variable instead of MEMBER.
  {
    const step = pool && node(pool, p.disable.key);
    const kw = (step?.impl?.keywords ?? {}) as Record<string, unknown>;
    const loop = kw.loop ?? kw.with_items ?? kw.with_list;
    const items = Array.isArray(loop) ? loop.map(text) : text(loop).split(/[^a-z0-9-]+/i);
    const all = p.members.every((m) => items.includes(m));
    const loopVar = text(
      (kw.loop_control as Record<string, unknown> | undefined)?.loop_var ?? 'item',
    );
    const cmd = step?.impl?.params?.cmd;
    const okCmd = reads(cmd, loopVar) && !text(cmd).includes(p.placeholder);
    add(
      'D4',
      all && okCmd ? 'pass' : loop ? 'review' : 'fail',
      `loop ${JSON.stringify(loop ?? null)}; cmd "${text(cmd)}"`,
    );
  }

  // D5: the report reads the state step's standard output through an input of its own: the whole
  // result plus .stdout (the @ list, 0.68.1), or an output that is already the stdout.
  {
    const report = pool && node(pool, p.report.key);
    const readState = pool && node(pool, p.readState.key);
    const msg = report?.impl?.params?.msg;
    const inputs = Object.entries(report?.inputs ?? {});
    const fed = inputs.filter(([, f]) => (f?.from ?? '').startsWith(`${p.readState.key}.`));
    const good = fed.find(([name, f]) => {
      const out = (f?.from ?? '').slice(p.readState.key.length + 1).split('.');
      const source = readState?.outputs?.[out[0] ?? '']?.from ?? '';
      const path = [source.replace(/^impl\.register\.?/, ''), ...out.slice(1)]
        .filter(Boolean)
        .join('.');
      return path.startsWith('stdout')
        ? reads(msg, name)
        : source === 'impl.register' && out.length === 1 && readsField(msg, name, 'stdout');
    });
    const unfed = inputs.filter(([, f]) => !f?.from && f?.default === undefined).map(([n]) => n);
    const direct = readState ? readsField(msg, registerName(readState), 'stdout') : false;
    add(
      'D5',
      good && unfed.length === 0 ? 'pass' : good || fed.length || direct ? 'review' : 'fail',
      `inputs ${inputs.map(([n, f]) => `${n} (${f?.from ?? 'no source'})`).join(', ') || 'none'}; msg "${text(msg)}"${unfed.length ? `; unfed: ${unfed.join(', ')}` : ''}`,
    );
  }

  // D6: a flow input with a default of 300, a description, and not required.
  {
    const flowInputs = Object.entries(pool?.flow?.inputs ?? {}).filter(([, f]) => !f?.targets);
    const withDefault = flowInputs.find(([, f]) => Number(text(f?.default)) === p.drainWait);
    const f = withDefault?.[1];
    const described = (f?.description ?? '').trim().length > 0;
    const optional = f?.required !== true;
    add(
      'D6',
      withDefault && described && optional ? 'pass' : flowInputs.length ? 'review' : 'fail',
      flowInputs
        .map(
          ([n, x]) =>
            `${n}: ${x?.type ?? 'any'}, default ${x?.default ?? 'none'}${x?.required ? ', required' : ''}, "${x?.description ?? ''}"`,
        )
        .join('; ') || 'no flow input',
    );
  }

  const entries = runAudit(dirs.storage);
  // D7: a finished check run on the east data centre only; the answer names both pairs there.
  {
    const d = D.dns;
    const east = new Set(D.groups[D.dc]);
    const checksRun = runs(entries, d.key, 'check').filter((r) => r.finish);
    const onEast = checksRun.find((r) => {
      const { hosts } = runEvents(dirs.storage, dns?.flow?.id, r.launch.run);
      return hosts.size > 0 ? [...hosts].every((x) => east.has(x)) : r.launch.hosts === east.size;
    });
    const a = ans('D7');
    const pairs = [d.serial, d.resolver].filter(
      (s) => hostMentioned(a, s.fails) && mentionsAny(a, s.title),
    );
    const other = hostMentioned(a, D.other);
    const verdict: Verdict = !onEast ? 'fail' : pairs.length === 2 && !other ? 'pass' : 'review';
    add(
      'D7',
      verdict,
      `${checksRun.length} finished check run(s), on ${checksRun.map((r) => r.launch.hosts).join(', ') || 'none'} hosts; ${onEast ? 'one on dc_east only' : 'none on dc_east only'}; answer names ${pairs.length} of 2 pairs${other ? `, and ${D.other}` : ''}`,
    );
  }

  // D8: the host, where it ended and where it was expected, and why (the forced peer check).
  {
    const h = D.health;
    const a = ans('D8');
    const said = [
      hostMentioned(a, h.second.fails),
      mentions(a, 'stopped'),
      mentionsAny(a, h.reported) || /\bnoc\b|\breported\b/i.test(a),
      /\bpeer\b|\bsync\b|\bforc/i.test(a),
    ];
    add(
      'D8',
      said.every(Boolean) ? 'pass' : a.trim() ? 'review' : 'fail',
      `answer names ${said.filter(Boolean).length} of 4: host, Stopped, ${h.reported}, the forced peer check`,
    );
  }

  // D9: the step that needs root keeps become with an accepted finding and a reason; the other
  // loses become. Read through findAccepted, so either decision format counts.
  {
    const u = D.upgrade;
    const sub = (key: string) => u.subflows.find((s) => s.steps.some((x) => x.key === key))?.key;
    const root = upgrade && node(upgrade, `${sub(u.needsRoot)}/${u.needsRoot}`);
    const noRoot = upgrade && node(upgrade, `${sub(u.noRoot)}/${u.noRoot}`);
    const accepted =
      upgrade && root ? findAccepted(upgrade, 'lens', `access:become:${root.id}`) : undefined;
    const reason = (accepted?.reason ?? '').trim();
    const a = Boolean(root?.settings?.become && reason);
    const b = Boolean(noRoot && !noRoot.settings?.become);
    add(
      'D9',
      a && b ? 'pass' : root?.settings?.become && b ? 'review' : 'fail',
      `${root?.title}: become ${Boolean(root?.settings?.become)}, accepted ${accepted ? `("${reason}")` : 'no'}; ${noRoot?.title}: become ${Boolean(noRoot?.settings?.become)}`,
    );
  }

  // D10: the added step, the renamed one (new or old title), the rebound one and the retimed one.
  {
    const a = ans('D10');
    const found = [
      mentions(a, 'health probe'),
      mentions(a, 'certificate') || (mentions(a, 'VIPs answer') && /renam/i.test(a)),
      mentions(a, 'image'),
      mentions(a, 'wait balancer') || /\bretr|\bdelay/i.test(a),
    ];
    const n = found.filter(Boolean).length;
    add('D10', n === 4 ? 'pass' : a.trim() ? 'review' : 'fail', `answer names ${n} of 4 changes`);
  }
  return checks;
}
