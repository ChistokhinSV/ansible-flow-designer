// AFD-339 (ADR-0038): where a value comes from, as a chain of hops. A step's input, a `from:` path
// or a `{{ name }}` it reads is followed through the flow: subflow inputs, outputs lifted from inner
// steps, registered results, set_fact (literal or templated), flow inputs, external vars and
// Ansible's magic vars. Only what the flow file says: the repository's variables are phase 2
// (AFD-340), run-time values phase 3. Pure: the tooltips, Details, the Data lens and flow_describe
// all render the same answer.
import { stringify } from 'yaml';
import type { ResultField } from '../catalog/draft';
import { holdsSecret, SECRET } from '../import/secrets';
import {
  defLabel,
  RANK,
  type RepoAnswer,
  type RepoContext,
  rankWord,
  repoAnswer,
  stepFile,
  type VarDef,
  type VarIndex,
} from '../inventory/varIndex';
import { MAGIC } from '../view/jinjaVocabulary';
import { outputVar, registerName } from './dataNames';
import { liftOf, resolveFrom, upstreamNodes } from './dataRefs';
import { factSource, setFactNames } from './facts';
import { refsIn } from './jinja';
import type { FlowModel } from './model';
import type { FlowNode, Ulid } from './types';

export type HopKind =
  | 'nodeInput'
  | 'subflowInput'
  | 'flowInput'
  | 'output'
  | 'lifted'
  | 'register'
  | 'setFact'
  /** An output a role or playbook sets when it runs (not known to the flow). */
  | 'runtime'
  /** An output of a step with no binding yet: the skeleton's placeholder. */
  | 'placeholder'
  | 'external'
  | 'magic'
  | 'unknown'
  // AFD-340: the repository's definitions, with `file`, `line` and `rank`.
  | 'groupVar'
  | 'hostVar'
  | 'roleDefault'
  | 'roleVar'
  | 'roleSpec'
  | 'varsFile'
  | 'includeVars';

export interface Hop {
  kind: HopKind;
  /** The hop in words, as a tooltip line shows it. */
  label: string;
  /** The variable, input or output name at this hop. */
  name: string;
  /** What is read inside the value (`stdout`, `a.b`). */
  path: string[];
  /** The step to select for this hop. */
  node?: Ulid;
  /** 0 on the main chain; the variables a template reads are one deeper than the template. */
  depth: number;
  /** A literal value as one line of YAML (cut in the middle). Never set on a secret chain. */
  value?: string;
  /** An input's default: what the step gets when its source leaves nothing. */
  fallback?: string;
  /** The template a value is; the variables it reads follow as deeper hops. */
  template?: string;
  /** The value is known from the file (a literal or a default with nothing in front of it). */
  static: boolean;
  /** This hop is why the chain is secret. */
  secret?: boolean;
  /** More about the hop: a result field's doc, a magic var's doc, where an external var is set. */
  doc?: string;
  /** AFD-340: the file (from the repository root) and zero-based line that define it. */
  file?: string;
  line?: number;
  /** AFD-340: its precedence rank (RANK in inventory/varIndex), shown as a word (`rankWord`). */
  rank?: number;
}

/** AFD-340: every place in the repository that defines the name, and which one wins. */
export interface Defined {
  name: string;
  /** Highest rank first; documentation (argument_specs) last. */
  hops: Hop[];
  /** Index into `hops` of the definition that wins, when it is certain. */
  winner?: number;
  /** The host picked, when one is. */
  host?: string;
  /** With a host picked: indexes into `hops` of definitions for other hosts and groups. */
  others?: number[];
  /** For whom: `for host x`, `for every host`, or the groups and hosts it depends on. */
  scope: string;
  /** Why there is no winner, or why it may still change. */
  why?: string;
  /** What the flow gives ranks above every one of them (`the input (play var)`): it wins. */
  beaten?: string;
}

export interface Origin {
  hops: Hop[];
  /** Precedence the flow already knows (a shadowing step, an extra var of the same name). */
  notes: string[];
  /** Some hop is secret: no hop carries a value, default or template. */
  secret: boolean;
  /** The chain was cut: a hop it had passed already, or too many hops. */
  cut?: 'cycle' | 'depth';
  /** AFD-340: the repository's definitions of the name asked about, with an index. */
  defined?: Defined;
}

/** A finding as origin reads it (the validator's, or the snapshot's). */
export interface OriginFinding {
  code: string;
  node?: Ulid;
  subject?: string;
  message: string;
  brief?: string;
}

export interface OriginOptions {
  /** A module step's documented result fields (the webview has the module docs). */
  fieldsOf?: (step: FlowNode) => ResultField[] | undefined;
  /** The flow's findings: input-shadowed and register-collision become notes. */
  findings?: readonly OriginFinding[];
  /** AFD-340: the repository's variables, when the host built them (absent: phase 1 answers). */
  index?: VarIndex;
  /** AFD-340: the host picked (inventory tree, Details): the winner is worked out for it. */
  host?: string;
}

const MAX_HOPS = 24;
const MAX_VALUE = 80;

/** A value as one line of YAML, cut in the middle when it is long. */
export function originValue(value: unknown, max = MAX_VALUE): string {
  let s =
    typeof value === 'string'
      ? value === ''
        ? '""'
        : value
      : stringify(value, { collectionStyle: 'flow', lineWidth: 0 }).trim();
  s = s.replaceAll(/\s*\n\s*/g, ' ');
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

const isTemplate = (v: unknown): v is string =>
  typeof v === 'string' && (v.includes('{{') || v.includes('{%'));

/** A step that keeps its values out of the output (`no_log`): its values are secret. */
export function noLog(node: FlowNode): boolean {
  const v = node.impl?.keywords?.no_log;
  return v === true || (typeof v === 'string' && /^(true|yes|\{\{)/i.test(v.trim()));
}

const rest = (path: readonly string[]) => (path.length ? ` · ${path.join('.')}` : '');

class Walk {
  hops: Hop[] = [];
  seen = new Set<string>();
  cut: Origin['cut'];
  constructor(
    readonly model: FlowModel,
    readonly opts: OriginOptions,
  ) {}

  /** Whether the walk may go on into `key`; records a cut otherwise. */
  enter(key: string): boolean {
    if (this.hops.length >= MAX_HOPS) {
      this.cut ??= 'depth';
      return false;
    }
    if (this.seen.has(key)) {
      this.cut ??= 'cycle';
      return false;
    }
    this.seen.add(key);
    return true;
  }

  push(hop: Omit<Hop, 'path'> & { path?: string[] }): Hop {
    const h: Hop = { path: [], ...hop };
    if (SECRET.test(h.name)) h.secret = true;
    this.hops.push(h);
    return h;
  }

  /** A template's variables, each one deeper, read as `reader` reads them. */
  template(reader: FlowNode, text: string, depth: number): void {
    for (const name of refsIn(text)) this.name(reader, name, depth + 1);
  }

  /** A node input (a subflow's input too) and where its value comes from. */
  input(node: FlowNode, name: string, depth: number, path: string[] = []): void {
    if (!this.enter(`in:${node.id}.${name}`)) return;
    const field = node.inputs?.[name];
    const sub = node.type === 'subflow';
    const kind = sub ? 'subflowInput' : 'nodeInput';
    const who = sub ? `subflow "${node.title}"` : `"${node.title}"`;
    const from = field?.from?.trim();
    const dflt = field?.default;
    const level = this.model.nodes.get(node.id)?.level;
    if (from && level) {
      this.push({
        kind,
        label: `input ${name} of ${who}${rest(path)}`,
        name,
        path,
        node: node.id,
        depth,
        static: false,
        ...(dflt !== undefined ? { fallback: originValue(dflt) } : {}),
        secret: noLog(node) || holdsSecret(dflt) || undefined,
      });
      this.from(node, level, 'inputs', from, depth);
      return;
    }
    if (dflt !== undefined) {
      this.push({
        kind,
        label: `input ${name} of ${who}: its default`,
        name,
        path,
        node: node.id,
        depth,
        value: originValue(dflt),
        static: !isTemplate(dflt),
        ...(isTemplate(dflt) ? { template: dflt } : {}),
        secret: noLog(node) || holdsSecret(dflt) || undefined,
      });
      if (isTemplate(dflt)) this.template(node, dflt, depth);
      return;
    }
    // AFD-293: nothing feeds it and no default: the code sets no var, so the step reads the name
    // as Ansible has it for the host.
    this.push({
      kind,
      label: `input ${name} of ${who}: nothing feeds it`,
      name,
      path,
      node: node.id,
      depth,
      static: false,
    });
    this.outside(node, name, depth);
  }

  /** A `from:` as `reader` on `level` reads it. */
  from(
    reader: FlowNode,
    level: string,
    side: 'inputs' | 'outputs',
    from: string,
    depth: number,
  ): void {
    const src = resolveFrom(this.model, reader, level, side, from);
    switch (src.kind) {
      case 'flow':
        this.flowInput(src.name, src.path, depth);
        return;
      case 'impl':
        this.register(reader, src.path[0] === 'register' ? src.path.slice(1) : src.path, depth);
        return;
      case 'output':
        if (src.name) this.output(src.node, src.name, src.path, depth);
        else
          this.push({
            kind: 'unknown',
            label: `"${from}" names a step but no output`,
            name: from,
            node: src.node.id,
            depth,
            static: false,
          });
        return;
      case 'subflowInput':
        this.input(src.node, src.name, depth, src.path);
        return;
      case 'unresolved':
        this.push({
          kind: 'unknown',
          label: `"${from}" ${src.why}`,
          name: from,
          node: src.target?.id,
          depth,
          static: false,
        });
        return;
    }
  }

  flowInput(name: string, path: string[], depth: number, direct = false): void {
    if (!this.enter(`flow:${name}`)) return;
    const field = this.model.doc.flow?.inputs?.[name];
    const dflt = field?.default;
    const asked = field?.targets
      ? 'the hosts the run starts on'
      : dflt !== undefined
        ? 'asked when the run starts'
        : field?.required
          ? 'asked when the run starts, required'
          : 'asked when the run starts, may be left empty';
    this.push({
      kind: 'flowInput',
      label: `flow input ${name}${rest(path)} (${asked}${direct ? '; read directly, as an extra var' : ''})`,
      name,
      path,
      depth,
      ...(dflt !== undefined ? { value: originValue(dflt) } : {}),
      static: false,
      doc: field?.description,
      secret: holdsSecret(dflt) || undefined,
    });
  }

  /** What `node`'s module or role returned, at `path` (`impl.register[.path]`). */
  register(node: FlowNode, path: string[], depth: number): void {
    if (!this.enter(`reg:${node.id}.${path.join('.')}`)) return;
    const field = path[0] ? this.opts.fieldsOf?.(node)?.find((f) => f.name === path[0]) : undefined;
    const what = node.impl ? `${node.impl.ref}` : 'its binding (none yet)';
    this.push({
      kind: 'register',
      label: `result of "${node.title}" (${what}), registered as ${registerName(node)}${rest(path)}`,
      name: registerName(node),
      path,
      node: node.id,
      depth,
      static: false,
      doc: field?.detail || undefined,
      secret: noLog(node) || undefined,
    });
  }

  /** An output of `node` and what sets it. */
  output(node: FlowNode, name: string, path: string[], depth: number): void {
    if (!this.enter(`out:${node.id}.${name}`)) return;
    const field = node.outputs?.[name];
    const from = field?.from?.trim();
    if (node.type === 'subflow') {
      const lift = liftOf(node, name);
      if (lift && 'inner' in lift) {
        this.push({
          kind: 'lifted',
          label: `output ${name} of subflow "${node.title}", lifted from "${lift.inner.title}"${rest(path)}`,
          name,
          path,
          node: node.id,
          depth,
          static: false,
        });
        this.output(lift.inner, lift.output, [...lift.path, ...path], depth);
        return;
      }
      this.push({
        kind: 'unknown',
        label:
          lift && 'ambiguous' in lift
            ? `output ${name} of subflow "${node.title}": several inner steps have it (${lift.ambiguous.join(', ')})`
            : `output ${name} of subflow "${node.title}": no inner step gives it`,
        name,
        path,
        node: node.id,
        depth,
        static: false,
      });
      return;
    }
    if (from?.startsWith('impl.')) {
      const [, ...p] = from.split('.');
      this.register(node, [...(p[0] === 'register' ? p.slice(1) : p), ...path], depth);
      return;
    }
    if (setFactNames(node.impl).includes(name)) {
      this.fact(node, name, path, depth);
      return;
    }
    if (node.impl) {
      this.push({
        kind: 'runtime',
        label: `output ${name} of "${node.title}": set by ${node.impl.kind} ${node.impl.ref} when it runs${rest(path)}`,
        name,
        path,
        node: node.id,
        depth,
        static: false,
        secret: noLog(node) || undefined,
      });
      return;
    }
    const dflt = field?.default;
    this.push({
      kind: 'placeholder',
      label: `output ${name} of "${node.title}": no binding yet, a placeholder for the skeleton run`,
      name,
      path,
      node: node.id,
      depth,
      ...(dflt !== undefined ? { value: originValue(dflt) } : {}),
      static: dflt !== undefined,
    });
  }

  /** A fact `node` sets with set_fact: its literal value, or its template and what that reads. */
  fact(node: FlowNode, name: string, path: string[], depth: number, inside?: FlowNode): void {
    if (!this.enter(`fact:${node.id}.${name}`)) return;
    const params = node.impl?.params as Record<string, unknown> | undefined;
    const raw = params?.[name];
    const templ = isTemplate(raw) ? raw : undefined;
    const conditional = node.impl?.keywords?.when !== undefined;
    this.push({
      kind: 'setFact',
      label: `set_fact in "${node.title}"${inside ? `, inside "${inside.title}"` : ''}${conditional ? ' (when its condition holds)' : ''}${rest(path)}`,
      name,
      path,
      node: node.id,
      depth,
      ...(templ !== undefined ? { template: templ } : { value: originValue(raw) }),
      static: !templ && !conditional,
      secret: noLog(node) || holdsSecret(raw) || undefined,
    });
    if (templ !== undefined) this.template(node, templ, depth);
  }

  /** A name `reader` reads that no input of it gives: what sets it before, or outside the flow. */
  outside(reader: FlowNode, name: string, depth: number): void {
    const flow = this.model.doc.flow;
    if (flow?.inputs && name in flow.inputs) {
      this.flowInput(name, [], depth, true);
      return;
    }
    const where = flow?.external_vars?.[name];
    if (where !== undefined) {
      this.push({
        kind: 'external',
        label: `set outside the flow: ${where || 'no place given'}`,
        name,
        depth,
        static: false,
      });
      return;
    }
    const source = factSource(this.model, reader, name);
    if (source) {
      if (source.how === 'output') this.output(source.node, name, [], depth);
      else if (source.how === 'set_fact') this.fact(source.node, name, [], depth);
      else this.fact(source.inner, name, [], depth, source.node);
      return;
    }
    // A module step's registered result read by its register name.
    const reg = upstreamNodes(this.model, reader.id).find(
      (up) => up.impl?.kind === 'module' && registerName(up) === name,
    );
    if (reg) {
      this.register(reg, [], depth);
      return;
    }
    const magic = MAGIC.find((w) => w.name === name);
    if (magic) {
      this.push({
        kind: 'magic',
        label: `Ansible sets ${name} for each host`,
        name,
        depth,
        static: false,
        doc: magic.doc,
      });
      return;
    }
    const index = this.opts.index;
    if (!index) {
      this.push({
        kind: 'unknown',
        label: `not set in this flow: decided at run time (inventory, group_vars, facts or extra vars)`,
        name,
        depth,
        static: false,
      });
      return;
    }
    // AFD-340: what the repository holds, and the one that wins when that is certain.
    const answer = repoAnswer(index, name, repoContext(this.model, reader), this.opts.host);
    if (answer?.winner && this.enter(`repo:${name}`)) {
      const hop = this.push(defHop(answer.winner, depth));
      hop.label = `${hop.label} (wins ${answer.scope})`;
      if (answer.winner.template) this.template(reader, answer.winner.template, depth);
      return;
    }
    this.push({
      kind: 'unknown',
      label: answer
        ? `not set in this flow; the repository sets it ${answer.scope.startsWith('depends') ? 'per host' : answer.scope}${answer.why ? ` (${answer.why})` : ''}`
        : `not set in this flow or the repository's static files: decided at run time (facts, extra vars or a dynamic inventory)`,
      name,
      depth,
      static: false,
    });
  }

  /** A `{{ name }}` `reader` reads: its input of that name, else what sets it before. */
  name(reader: FlowNode, name: string, depth: number): void {
    if (reader.inputs?.[name]) this.input(reader, name, depth);
    else this.outside(reader, name, depth);
  }

  done(notes: string[], defined?: Defined): Origin {
    const secret = this.hops.some((h) => h.secret);
    if (secret)
      for (const h of [...this.hops, ...(defined?.hops ?? [])]) {
        delete h.value;
        delete h.fallback;
        delete h.template;
        h.static = false;
      }
    return {
      hops: this.hops,
      notes,
      secret,
      ...(this.cut ? { cut: this.cut } : {}),
      ...(defined ? { defined } : {}),
    };
  }
}

/** AFD-340: whose repository definitions a step sees: its role, its own file, earlier steps' files. */
export function repoContext(model: FlowModel, reader: FlowNode): RepoContext {
  const own = stepFile(reader);
  return {
    ...(reader.impl?.kind === 'role' && reader.impl.ref ? { role: reader.impl.ref } : {}),
    own: own ? [own] : [],
    upstream: upstreamNodes(model, reader.id).flatMap((n) => {
      const f = stepFile(n);
      return f ? [f] : [];
    }),
  };
}

const DEF_KIND = {
  group: 'groupVar',
  host: 'hostVar',
  varsFile: 'varsFile',
  includeVars: 'includeVars',
} as const;

/** AFD-340: a repository definition as a hop. */
export function defHop(d: VarDef, depth: number): Hop {
  const kind: HopKind =
    d.scope.kind === 'role'
      ? d.scope.part === 'defaults'
        ? 'roleDefault'
        : d.scope.part === 'vars'
          ? 'roleVar'
          : 'roleSpec'
      : DEF_KIND[d.scope.kind];
  return {
    kind,
    label: defLabel(d),
    name: d.name,
    path: [],
    depth,
    file: d.file,
    line: d.line,
    rank: d.rank,
    ...(d.value !== undefined ? { value: d.value } : {}),
    ...(d.template !== undefined ? { template: d.template } : {}),
    static: d.value !== undefined && d.rank > 0,
    ...(d.secret ? { secret: true } : {}),
    ...(d.doc ? { doc: d.doc } : {}),
  };
}

/** A few definitions in words, with file and line (never a value). */
function places(defs: readonly VarDef[]): string {
  const shown = defs
    .slice(0, 3)
    .map((d) => `${defLabel(d)}, ${d.file}:${d.line + 1}`)
    .join('; ');
  return defs.length > 3 ? `${shown}; and ${defs.length - 3} more` : shown;
}

/** AFD-340: the repository's definitions of `name` as `node` reads it. */
function definedOf(
  model: FlowModel,
  node: FlowNode,
  name: string,
  opts: OriginOptions,
): { defined?: Defined; answer?: RepoAnswer } {
  if (!opts.index) return {};
  const answer = repoAnswer(opts.index, name, repoContext(model, node), opts.host);
  if (!answer) return {};
  const winner = answer.winner ? answer.defs.indexOf(answer.winner) : -1;
  const applies = answer.applies;
  const others = applies
    ? answer.defs.flatMap((d, i) => (d.rank > 0 && !applies.includes(d) ? [i] : []))
    : [];
  return {
    answer,
    defined: {
      name,
      hops: answer.defs.map((d) => defHop(d, 0)),
      ...(winner >= 0 ? { winner } : {}),
      ...(opts.host ? { host: opts.host } : {}),
      ...(others.length ? { others } : {}),
      scope: answer.scope,
      ...(answer.why ? { why: answer.why } : {}),
    },
  };
}

const capital = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`;

/** AFD-340: the repository's values against what the flow gives at `rank` (`what`, in words). */
function rankNotes(
  answer: RepoAnswer | undefined,
  name: string,
  rank: number,
  what: string,
): string[] {
  const values = (answer?.defs ?? []).filter((d) => d.rank > 0);
  const lower = values.filter((d) => d.rank < rank);
  const higher = values.filter((d) => d.rank > rank);
  const notes: string[] = [];
  for (const d of higher.slice(0, 2))
    notes.push(
      `The ${defLabel(d)} (${d.file}:${d.line + 1}) is a ${rankWord(d.rank)}: it ranks above ${what} (${rankWord(rank)}) and wins over it.`,
    );
  if (lower.length)
    notes.push(
      `${capital(what)} (${rankWord(rank)}) wins over the repository's ${name}: ${places(lower)}.`,
    );
  return notes;
}

/** Whether an input reads a value of its own name (AFD-293: the code reads the host's own var). */
function sameNameRead(model: FlowModel, node: FlowNode, name: string): boolean {
  const from = node.inputs?.[name]?.from?.trim();
  const level = model.nodes.get(node.id)?.level;
  if (!from || !level) return false;
  const src = resolveFrom(model, node, level, 'inputs', from);
  return (
    (src.kind === 'flow' && src.name === name && src.path.length === 0) ||
    (src.kind === 'output' &&
      src.path.length === 0 &&
      outputVar(model, src.node, src.name) === name)
  );
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** AFD-340: what the repository's definitions mean next to `node`'s input `name`. */
function inputRepoNotes(
  model: FlowModel,
  node: FlowNode,
  name: string,
  answer: RepoAnswer | undefined,
): string[] {
  const field = node.inputs?.[name];
  const from = field?.from?.trim();
  const notes: string[] = [];
  if (node.impl?.kind === 'role' && isMapping(node.impl.params) && name in node.impl.params)
    notes.push(
      `The step passes ${name} to the role as a role param too: a role param ranks above the input and wins over it.`,
    );
  if (!answer) return notes;
  if (from && sameNameRead(model, node, name)) {
    if (answer.winner && field?.default !== undefined)
      notes.push(
        `${capital(answer.scope)}, the host's own ${name} is the ${defLabel(answer.winner)} (${answer.winner.file}:${answer.winner.line + 1}): it wins over the default.`,
      );
    return notes;
  }
  if (!from && field?.default === undefined) return notes;
  // An input with a source, or with a default and no source, is a play var of the step.
  notes.push(...rankNotes(answer, name, RANK.playVar, from ? 'the input' : "the input's default"));
  return notes;
}

/** The rank of what the flow gives at the head of a chain, when the flow gives it. */
function headRank(head: Hop | undefined): number | undefined {
  switch (head?.kind) {
    case 'setFact':
    case 'register':
    case 'output':
    case 'lifted':
    case 'runtime':
      return RANK.setFact;
    case 'flowInput':
    case 'external':
      return RANK.extraVar;
    default:
      return undefined;
  }
}

/** The rank an input of a step gives its value at: a role param, a play var, or none (AFD-293). */
function inputRank(model: FlowModel, node: FlowNode, name: string): number | undefined {
  const field = node.inputs?.[name];
  if (node.impl?.kind === 'role' && isMapping(node.impl.params) && name in node.impl.params)
    return RANK.roleParam;
  if (field?.from?.trim()) return sameNameRead(model, node, name) ? undefined : RANK.playVar;
  return field?.default !== undefined ? RANK.playVar : undefined;
}

/** Marks the repository's definitions as beaten when the flow's value ranks above all of them. */
function beat(defined: Defined | undefined, rank: number | undefined, what: string): void {
  if (!defined || rank === undefined) return;
  const values = defined.hops.filter((h) => (h.rank ?? 0) > 0);
  if (values.length && values.every((h) => (h.rank ?? 0) < rank))
    defined.beaten = `${what} (${rankWord(rank)})`;
}

const UNKNOWN_READS = new Set([
  'binding-unknown-var',
  'condition-unknown-var',
  'setting-unknown-var',
]);

/**
 * AFD-340: a step that reads a name the repository sets (group_vars, host_vars, the inventory, its
 * role, a vars file) is not reading something unknown: its warning becomes information that says
 * where the repository sets it. Add as input stays, to show the dependency on the canvas.
 */
export function quietRepoReads<
  F extends OriginFinding & { severity: string; path?: readonly (string | number)[] },
>(findings: readonly F[], model: FlowModel, index: VarIndex): F[] {
  return findings.map((f) => {
    if (!UNKNOWN_READS.has(f.code) || f.severity !== 'warning' || !f.node || !f.subject) return f;
    const node = model.nodes.get(f.node)?.node;
    if (!node) return f;
    const defs = (repoAnswer(index, f.subject, repoContext(model, node))?.defs ?? []).filter(
      (d) => d.rank > 0,
    );
    if (!defs.length) return f;
    const where = places(defs);
    return {
      ...f,
      severity: 'info',
      brief: `${f.subject} is set by the repository (${where}), not by an input of this step. Add it as an input to show where it comes from.`,
      message: `"${node.title ?? node.key}" reads "${f.subject}", which the repository sets (${where}), not an input of this step`,
    };
  });
}

/** AFD-340: where the repository sets a name a step reads (a few places in words), if it does. */
export function repoSetsName(
  model: FlowModel,
  node: FlowNode,
  name: string,
  index: VarIndex | undefined,
): string | undefined {
  if (!index) return undefined;
  const defs = (repoAnswer(index, name, repoContext(model, node))?.defs ?? []).filter(
    (d) => d.rank > 0,
  );
  return defs.length ? places(defs) : undefined;
}

/** A finding origin gives the host: the validator's shape. */
export interface RepoFinding extends OriginFinding {
  severity: 'info';
  path: (string | number)[];
}

/**
 * AFD-340: an input whose default hides what the inventory sets for the hosts. The default is a
 * play var, which ranks above group and host variables, so the step never gets the inventory's
 * value. An info finding, which the host adds to the validator's when it has the index.
 */
export function repoFindings(model: FlowModel, index: VarIndex): RepoFinding[] {
  const out: RepoFinding[] = [];
  for (const { node, path } of model.nodes.values()) {
    for (const [name, field] of Object.entries(node.inputs ?? {})) {
      if (field?.from?.trim() || field?.default === undefined) continue;
      const answer = repoAnswer(index, name, repoContext(model, node));
      const hidden = (answer?.defs ?? []).filter(
        (d) => (d.scope.kind === 'group' || d.scope.kind === 'host') && d.rank < RANK.playVar,
      );
      if (!hidden.length) continue;
      out.push({
        code: 'input-hides-inventory',
        severity: 'info',
        node: node.id,
        subject: name,
        path: [...path, 'inputs', name],
        brief: `The default of ${name} wins over the inventory's ${name} (${places(hidden)}): the step never gets the inventory value. Remove the default to read the host's own, or keep it on purpose.`,
        message: `"${node.title ?? node.key}" inputs.${name}: its default is a play var and wins over the inventory's ${name} (${places(hidden)}), so the step never gets the inventory value`,
      });
    }
  }
  return out;
}

/** Precedence the flow knows for `node`'s input `name`. */
function inputNotes(model: FlowModel, node: FlowNode, name: string, opts: OriginOptions): string[] {
  const notes: string[] = [];
  for (const f of opts.findings ?? [])
    if (
      (f.code === 'input-shadowed' || f.code === 'register-collision') &&
      f.node === node.id &&
      f.subject === name
    )
      notes.push(f.brief ?? f.message);
  const field = node.inputs?.[name];
  const from = field?.from?.trim();
  const flow = model.doc.flow;
  // An input is generated as a play var; extra vars of the same name rank above it.
  if (flow?.inputs && name in flow.inputs && from !== `flow.${name}`)
    notes.push(
      `The flow input ${name} has this name too: Ansible gives it to every step as an extra var, and it wins over this input.`,
    );
  else if (flow?.external_vars && name in flow.external_vars)
    notes.push(
      `${name} is also set outside the flow (${flow.external_vars[name] || 'no place given'}); an extra var of that name wins over this input.`,
    );
  if (field?.default !== undefined && from) {
    const level = model.nodes.get(node.id)?.level;
    const src = level ? resolveFrom(model, node, level, 'inputs', from) : undefined;
    const same =
      (src?.kind === 'flow' && src.name === name && src.path.length === 0) ||
      (src?.kind === 'output' &&
        src.path.length === 0 &&
        outputVar(model, src.node, src.name) === name);
    notes.push(
      same
        ? `The step reads the host's own ${name} first (inventory, facts or extra vars); the default is used only when the host has none.`
        : 'The default is used when the source leaves nothing.',
    );
  }
  return notes;
}

/** Where `node`'s input `name` gets its value. */
export function inputOrigin(
  model: FlowModel,
  node: FlowNode,
  name: string,
  opts: OriginOptions = {},
): Origin {
  const w = new Walk(model, opts);
  w.input(node, name, 0);
  const { defined, answer } = definedOf(model, node, name, opts);
  beat(defined, inputRank(model, node, name), 'the input');
  return w.done(
    [...inputNotes(model, node, name, opts), ...inputRepoNotes(model, node, name, answer)],
    defined,
  );
}

/** Where a `from:` on `node`'s `side` reads (an output's `from` reads the node's inner level). */
export function fromOrigin(
  model: FlowModel,
  node: FlowNode,
  side: 'inputs' | 'outputs',
  from: string,
  opts: OriginOptions = {},
): Origin {
  const w = new Walk(model, opts);
  const level = model.nodes.get(node.id)?.level;
  if (level) w.from(node, level, side, from, 0);
  return w.done([]);
}

/** Where a `{{ name }}` in `node`'s parameters, keywords or condition comes from. */
export function nameOrigin(
  model: FlowModel,
  node: FlowNode,
  name: string,
  opts: OriginOptions = {},
): Origin {
  const w = new Walk(model, opts);
  w.name(node, name, 0);
  const { defined, answer } = definedOf(model, node, name, opts);
  if (node.inputs?.[name]) {
    beat(defined, inputRank(model, node, name), 'the input');
    return w.done(
      [...inputNotes(model, node, name, opts), ...inputRepoNotes(model, node, name, answer)],
      defined,
    );
  }
  // A name the flow sets (a fact, a register, an extra var) against the repository's values.
  const rank = headRank(w.hops.filter((h) => h.depth === 0).at(-1));
  beat(defined, rank, 'what the flow sets');
  return w.done(
    rank !== undefined ? rankNotes(answer, name, rank, 'what the flow sets') : [],
    defined,
  );
}

/** What sets `node`'s output `name` (a subflow's: the inner step it lifts). */
export function outputOrigin(
  model: FlowModel,
  node: FlowNode,
  name: string,
  opts: OriginOptions = {},
): Origin {
  const w = new Walk(model, opts);
  w.output(node, name, [], 0);
  return w.done([]);
}

/** A flow input: how a run gives it. */
export function flowInputOrigin(model: FlowModel, name: string): Origin {
  const w = new Walk(model, {});
  w.flowInput(name, [], 0);
  return w.done([]);
}

/** The hop that decides the value: the last one on the main chain. */
export function originHead(origin: Origin): Hop | undefined {
  return origin.hops.filter((h) => h.depth === 0).at(-1);
}

/** One hop in words, with its value, default or template. */
export function hopText(h: Hop): string {
  const v =
    h.value !== undefined
      ? ` = ${h.value}`
      : h.template !== undefined
        ? ` = ${originValue(h.template)}`
        : '';
  const fb = h.fallback !== undefined ? ` (default ${h.fallback})` : '';
  const at = h.file !== undefined ? ` (${h.file}:${(h.line ?? 0) + 1})` : '';
  return `${h.label}${at}${v}${fb}${h.secret ? ' (secret: not shown)' : ''}`;
}

/** AFD-340: the repository's definitions as lines of text, the winner marked. */
export function definedText(d: Defined): string[] {
  const head = `Defined in the repository (${d.scope}${d.why ? `; ${d.why}` : ''})${d.beaten ? `, and ${d.beaten} wins over all of them` : ''}:`;
  return [
    head,
    ...d.hops.map(
      (h, i) =>
        `  ${i === d.winner ? (d.beaten ? '* highest here: ' : '* wins: ') : d.others?.includes(i) ? '(other hosts) ' : ''}${hopText(h)}${h.rank ? ` [${rankWord(h.rank)}]` : ''}`,
    ),
  ];
}

/** The whole origin as lines of text (titles, the AI tools): each hop, then the notes. */
export function originText(origin: Origin): string {
  const lines = origin.hops.map((h) => `${'  '.repeat(h.depth)}← ${hopText(h)}`);
  if (origin.secret) lines.push('Secret: values are not shown.');
  if (origin.cut)
    lines.push(
      origin.cut === 'cycle' ? '(the chain comes back to itself)' : '(cut: too many hops)',
    );
  const defined = origin.defined ? definedText(origin.defined) : [];
  return [...lines, ...origin.notes, ...defined].join('\n');
}
