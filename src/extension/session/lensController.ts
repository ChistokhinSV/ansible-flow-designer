// The facts a flow's lenses need (M8; AFD-38: out of FlowSession): the code the bindings point to,
// the run history for the Timing lens, and the inventory for the targets, read only when the lens
// is open and only again when what they depend on changed.
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import { modelOf } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import { timingStats } from '../../core/lens/history';
import { inventoryPatterns } from '../../core/lens/inventory';
import type { LensFacts, LensId } from '../../core/lens/types';
import type { HostMessage, RunView, Snapshot } from '../../core/protocol';
import { whenText } from '../../core/view/outsideChanges';
import type { SessionDeps } from '../flowSession';
import { fileVersions, textAt } from '../gitHead';
import { readCode, readInventory, rememberedTargets, rememberTargets } from '../lens/lensFacts';
import { readHistory, recordRun } from '../run/history';

/** The Changes lens's base before the outside changes (AFD-104), not a Git ref. */
const OUTSIDE = 'outside';

export interface OutsideBase {
  doc: FlowDocument;
  /** When the designer last showed it (closed), or when the first outside change came. */
  at: string;
  closed: boolean;
}

export class LensController {
  /** Lens facts gathered for this flow, as the panels have them. */
  facts: LensFacts = {};
  private open?: LensId;
  /** Targets and patterns of the last inventory read: a new pattern reads again. */
  private inventoryKey?: string;
  private codeKey?: string;
  /** The version the Changes lens compares with (AFD-57). */
  private compareRef = 'HEAD';
  /** AFD-104: the person picked a base; until then it follows the outside marks. */
  private picked = false;

  constructor(
    private readonly uri: vscode.Uri,
    private readonly deps: SessionDeps,
    private readonly broadcast: (message: HostMessage) => void,
    private readonly snapshot: () => Promise<Snapshot>,
    /**
     * AFD-104 (round 3: R9): the flow before its outside changes. A pulled commit is in HEAD, so
     * comparing with HEAD showed none of what the colleague changed.
     */
    private readonly outsideBase: () => OutsideBase | undefined = () => undefined,
  ) {}

  /** The marks began or went: a Changes lens left on its default base follows them. */
  async outsideChanged(): Promise<void> {
    if (this.open !== 'changes' || this.picked) return;
    this.compareRef = this.outsideBase() ? OUTSIDE : 'HEAD';
    await this.readBase();
  }

  /** A new snapshot: the open lens's facts follow the flow. */
  followed(doc: FlowDocument): void {
    if (this.open) void this.gather(doc, false);
  }

  async show(lens: LensId | null, refresh = false): Promise<void> {
    this.open = lens ?? undefined;
    if (lens === 'changes' && !this.picked) this.compareRef = this.outsideBase() ? OUTSIDE : 'HEAD';
    const doc = (await this.snapshot()).doc;
    if (doc) await this.gather(doc, refresh);
  }

  /** The Inventory lens's "Set targets": asks, remembers with the run inputs, reads again. */
  async askTargets(): Promise<void> {
    const deps = this.deps.lens;
    const doc = (await this.snapshot()).doc;
    if (!deps || !doc) return;
    const text = await vscode.window.showInputBox({
      title: `${doc.flow.name}: flow targets`,
      prompt: 'Hosts or groups the flow runs on, comma-separated (remembered for runs too)',
      value: rememberedTargets(doc, deps.state),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter at least one host or group'),
    });
    if (text === undefined) return;
    await rememberTargets(doc, deps.state, text);
    await this.gather(doc, true);
  }

  /** Test API: targets without the input box. */
  async useTargets(text: string): Promise<void> {
    const deps = this.deps.lens;
    const doc = (await this.snapshot()).doc;
    if (!deps || !doc) return;
    await rememberTargets(doc, deps.state, text);
    await this.gather(doc, true);
  }

  /** The Changes lens's base picker: read the flow as that version has it. */
  async compareWith(ref: string): Promise<void> {
    this.compareRef = ref;
    this.picked = true;
    if (this.open === 'changes') await this.readBase();
  }

  /** The compared version of the flow, from Git (AFD-57); nothing is cached across picks. */
  private async readBase(): Promise<void> {
    const outside = this.outsideBase();
    const ref = this.compareRef === OUTSIDE && !outside ? 'HEAD' : this.compareRef;
    const git = await fileVersions(this.uri);
    const refs = [
      ...(outside
        ? [
            {
              ref: OUTSIDE,
              label: outside.closed
                ? `the flow as you last had it open (${whenText(outside.at)})`
                : `the flow before the outside changes (${whenText(outside.at)})`,
            },
          ]
        : []),
      ...git,
    ];
    const label = refs.find((r) => r.ref === ref)?.label ?? ref;
    this.facts.compare = { state: 'loading', ref, label, refs };
    this.broadcast({ type: 'lensFacts', facts: { compare: this.facts.compare } });
    if (ref === OUTSIDE && outside) {
      this.facts.compare = { state: 'ready', ref, label, refs, base: outside.doc };
      this.broadcast({ type: 'lensFacts', facts: { compare: this.facts.compare } });
      return;
    }
    const text = git.length > 0 ? await textAt(this.uri, ref) : undefined;
    const base = text === undefined ? undefined : parseFlow(text).doc;
    this.facts.compare = base
      ? { state: 'ready', ref, label, refs, base }
      : {
          state: 'error',
          ref,
          label,
          refs,
          error:
            git.length === 0
              ? 'The flow is not in a Git repository: nothing to compare with'
              : text === undefined
                ? `${label} has no version of this flow`
                : `${label}: the flow file does not parse`,
        };
    this.broadcast({ type: 'lensFacts', facts: { compare: this.facts.compare } });
  }

  /** A finished real run joins the Timing lens's history. */
  ran(run: RunView, flowId: string | undefined): void {
    const deps = this.deps.lens;
    if (!deps || !flowId || run.state !== 'done') return;
    void recordRun(deps.storage, flowId, run).then((entries) => {
      if (!entries) return;
      this.facts.timing = timingStats(entries);
      this.broadcast({ type: 'lensFacts', facts: { timing: this.facts.timing } });
    });
  }

  /** Facts for the open lens; the inventory is read only when targets or patterns changed. */
  private async gather(doc: FlowDocument, refresh: boolean): Promise<void> {
    const lens = this.open;
    const deps = this.deps.lens;
    if (!lens) return;
    const bindings = JSON.stringify(
      [...modelOf(doc).nodes.values()].map((e) => e.node.impl?.ref ?? ''),
    );
    if (lens === 'changes') {
      if (refresh || this.facts.compare?.ref !== this.compareRef) await this.readBase();
      return;
    }
    if (lens !== 'data' && lens !== 'timing' && (refresh || this.codeKey !== bindings)) {
      this.codeKey = bindings;
      this.facts.code = await readCode(this.uri, doc, this.deps.catalog);
      this.broadcast({ type: 'lensFacts', facts: { code: this.facts.code } });
    }
    if (lens === 'timing' && deps && (refresh || !this.facts.timing)) {
      this.facts.timing = timingStats(await readHistory(deps.storage, doc.flow.id));
      this.broadcast({ type: 'lensFacts', facts: { timing: this.facts.timing } });
    }
    if ((lens === 'inventory' || lens === 'access') && deps) {
      const targets = rememberedTargets(doc, deps.state);
      const key = `${targets}|${inventoryPatterns(doc, targets, this.facts.code).join('|')}`;
      const current = this.facts.inventory;
      if (!refresh && this.inventoryKey === key && current?.state !== 'error') return;
      this.inventoryKey = key;
      this.facts.inventory = { state: 'loading', targets, facts: current?.facts };
      this.broadcast({ type: 'lensFacts', facts: { inventory: this.facts.inventory } });
      try {
        const { facts, inventory } = await readInventory(
          this.uri,
          doc,
          deps.probes,
          targets,
          this.facts.code,
        );
        this.facts.inventory = { state: 'ready', facts, targets, inventory };
      } catch (e) {
        this.inventoryKey = undefined;
        this.facts.inventory = { state: 'error', error: (e as Error).message, targets };
      }
      this.broadcast({ type: 'lensFacts', facts: { inventory: this.facts.inventory } });
    }
  }
}
