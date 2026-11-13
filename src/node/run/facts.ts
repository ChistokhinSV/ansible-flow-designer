// What a run would touch, asked of the inventory through the probe (the real-run confirmation and
// the launch dialog, AFD-82). AFD-271: without VS Code, for every host that runs flows.
import { resolvePattern, targetUses } from '../../core/engine/targets';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import { type LaunchFacts, type TargetUse, targetsOf } from '../../core/run/launch';
import { groupHosts, type InventoryTree } from '../../core/view/inventoryTree';
import { TIMEOUTS } from '../timeouts';

/** The probe of the Ansible environment a run uses, and the name people know it by. */
export interface RunProbe {
  client: {
    call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  };
  label: string;
}

interface InventoryFacts {
  sources: string[];
  count: number;
  hosts: string[];
  unknown: string[];
  prod_groups: string[];
  prod_hosts: string[];
  vault: boolean;
  /** Per group, how many of the matched hosts it has. */
  groups?: Record<string, number>;
}

async function targetFacts(
  doc: FlowDocument,
  inputs: Record<string, unknown>,
  count: (pattern: string) => Promise<InventoryFacts>,
): Promise<TargetUse[]> {
  return Promise.all(
    targetUses(buildModel(doc)).map(async (u): Promise<TargetUse> => {
      const pattern = resolvePattern(u.target, inputs);
      const use: TargetUse = { pattern, declared: u.target, nodes: u.nodes, prod: [] };
      if (!pattern) return use;
      try {
        const f = await count(pattern);
        use.count = f.count;
        use.prod = [...f.prod_groups, ...f.prod_hosts];
      } catch {
        // Counted at run time only; the confirmation says so.
      }
      return use;
    }),
  );
}

/**
 * What a run with these inputs would touch: the hosts the targets match in the inventory, the
 * inventory_targets of the flow's steps, what looks like production.
 */
export async function launchFacts(
  doc: FlowDocument,
  inputs: Record<string, unknown>,
  probe: RunProbe,
  inventory: string | undefined,
): Promise<{ ok: true; facts: LaunchFacts } | { ok: false; error: string }> {
  const targets = targetsOf(doc, inputs);
  if (targets.length === 0)
    return { ok: false, error: 'No target hosts: the targets input is empty' };
  let found: InventoryFacts;
  try {
    found = await probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets },
      TIMEOUTS.probeInventory,
    );
  } catch (e) {
    return {
      ok: false,
      error: `The Ansible environment (${probe.label}) did not answer: ${(e as Error).message}`,
    };
  }
  if (found.count === 0)
    return { ok: false, error: `None of the targets (${targets.join(', ')}) is in the inventory` };
  const uses = await targetFacts(doc, inputs, (pattern) =>
    probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets: [pattern] },
      TIMEOUTS.probeInventory,
    ),
  );
  const prod = [
    ...new Set([...found.prod_groups, ...found.prod_hosts, ...uses.flatMap((u) => u.prod)]),
  ];
  return {
    ok: true,
    facts: {
      sources: found.sources,
      count: found.count,
      hosts: found.hosts,
      unknown: found.unknown,
      uses,
      prod,
      vault: found.vault,
      environment: probe.label,
    },
  };
}

/**
 * The inventory's groups, for the dialog's host list suggestions (AFD-82), with each group's hosts
 * (AFD-95, from the probe's inventory_tree, one inventory parse as before); none when it fails.
 */
export async function inventoryGroups(
  probe: RunProbe,
  inventory: string | undefined,
): Promise<{ groups: string[]; hosts: Record<string, { count: number; hosts: string[] }> }> {
  try {
    const tree = await probe.client.call<InventoryTree>(
      'inventory_tree',
      { inventory },
      TIMEOUTS.probeInventory,
    );
    const hosts = groupHosts(tree);
    return { groups: Object.keys(hosts).sort((a, b) => a.localeCompare(b)), hosts };
  } catch {
    return { groups: [], hosts: {} };
  }
}

/**
 * AFD-141: the callbacks the repository's ansible.cfg enables, so they keep running next to the
 * run's own; undefined when the environment does not answer (the run's callback alone, then).
 */
export async function repositoryCallbacks(
  probe: RunProbe,
): Promise<{ enabled: string[]; paths: string[] } | undefined> {
  return probe.client
    .call<{ callbacks_enabled: string[]; callback_plugins: string[] }>(
      'run_config',
      {},
      TIMEOUTS.probeInventory,
    )
    .then((c) => ({ enabled: c.callbacks_enabled ?? [], paths: c.callback_plugins ?? [] }))
    .catch(() => undefined);
}
