// AFD-339 (ADR-0038): where a value comes from, as a chain of hops. A step's input, a `from:` path
// or a `{{ name }}` it reads is followed through the flow: subflow inputs, outputs lifted from inner
// steps, registered results, set_fact (literal or templated), flow inputs, external vars and
// Ansible's magic vars. Only what the flow file says: the repository's variables are phase 2
// (AFD-340), run-time values phase 3. Pure: the tooltips, Details, the Data lens and flow_describe
// all render the same answer.
import { stringify } from 'yaml';
import type { ResultField } from '../catalog/draft';
import { holdsSecret, SECRET } from '../import/secrets';
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
  | 'unknown';
// Phase 2 (AFD-340) adds repository kinds (inventory, group_vars, host_vars, role defaults and
// vars, vars_files) with `file`, `line` and `rank`; callers render any hop the same way.

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
  /** Phase 2: the file and zero-based line that define it, and its precedence rank. */
  file?: string;
  line?: number;
  rank?: number;
}

export interface Origin {
  hops: Hop[];
  /** Precedence the flow already knows (a shadowing step, an extra var of the same name). */
  notes: string[];
  /** Some hop is secret: no hop carries a value, default or template. */
  secret: boolean;
  /** The chain was cut: a hop it had passed already, or too many hops. */
  cut?: 'cycle' | 'depth';
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
function noLog(node: FlowNode): boolean {
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
    this.push({
      kind: 'unknown',
      label: `not set in this flow: decided at run time (inventory, group_vars, facts or extra vars)`,
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

  done(notes: string[]): Origin {
    const secret = this.hops.some((h) => h.secret);
    if (secret)
      for (const h of this.hops) {
        delete h.value;
        delete h.fallback;
        delete h.template;
        h.static = false;
      }
    return { hops: this.hops, notes, secret, ...(this.cut ? { cut: this.cut } : {}) };
  }
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
  return w.done(inputNotes(model, node, name, opts));
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
  return w.done(node.inputs?.[name] ? inputNotes(model, node, name, opts) : []);
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
  return `${h.label}${v}${fb}${h.secret ? ' (secret: not shown)' : ''}`;
}

/** The whole origin as lines of text (titles, the AI tools): each hop, then the notes. */
export function originText(origin: Origin): string {
  const lines = origin.hops.map((h) => `${'  '.repeat(h.depth)}← ${hopText(h)}`);
  if (origin.secret) lines.push('Secret: values are not shown.');
  if (origin.cut)
    lines.push(
      origin.cut === 'cycle' ? '(the chain comes back to itself)' : '(cut: too many hops)',
    );
  return [...lines, ...origin.notes].join('\n');
}
