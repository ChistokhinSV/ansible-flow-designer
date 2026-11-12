// Catalog-backed checks of module bindings (M5, ADR-0011): what the environment says about the
// bound module. Runs only with a loaded index; the pure checks live in core/flow/validate.
import { documentedOptions, takesFreeKeys } from '../../core/catalog/freeKeys';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import type { Finding } from '../../core/flow/validate';
import type { CatalogIndex } from './catalogIndex';

export function checkBindings(
  doc: FlowDocument,
  index: CatalogIndex,
  environment: string,
): Finding[] {
  const out: Finding[] = [];
  for (const { node, path } of buildModel(doc).nodes.values()) {
    const impl = node.impl;
    if (impl?.kind !== 'module' || !impl.ref) continue;
    const at = [...path, 'impl', 'ref'];
    const who = `"${node.title}"`;
    const add = (code: string, severity: Finding['severity'], message: string, where = at) =>
      out.push({ code, severity, message, path: where, node: node.id });
    const r = index.resolve(impl.ref);
    if (!r.found) {
      if (r.removed)
        add('binding-removed', 'error', `${who}: ${impl.ref} was removed: ${r.removed}`);
      else
        add(
          'binding-not-in-ee',
          'warning',
          `${who}: ${impl.ref} is not in the environment (${environment})`,
        );
      continue;
    }
    const plugin = index.plugin(r.fqcn ?? impl.ref);
    if (!plugin) continue;
    if (r.fqcn !== impl.ref)
      add('binding-redirect', 'info', `${who}: ${impl.ref} runs as ${r.fqcn}`);
    const deprecated =
      r.deprecated ?? (plugin.deprecated ? plugin.deprecated.why || 'deprecated' : undefined);
    if (deprecated)
      add('binding-deprecated', 'warning', `${who}: ${r.fqcn} is deprecated: ${deprecated}`);
    if (plugin.attributes?.check_mode?.support === 'none')
      add(
        'binding-no-check-mode',
        'info',
        `${who}: ${r.fqcn} does not support check mode, so skeleton runs skip it`,
      );
    const options = documentedOptions(impl.ref, plugin.options) ?? {};
    const names = Object.keys(options);
    if (names.length === 0) continue;
    const params = Object.keys(impl.params ?? {});
    const known = new Map<string, string>();
    for (const [name, o] of Object.entries(options)) {
      known.set(name, name);
      for (const a of o.aliases ?? []) known.set(a, name);
    }
    const given = new Set(params.map((p) => known.get(p) ?? p));
    for (const [name, o] of Object.entries(options))
      if (o.required && o.default === undefined && !given.has(name))
        add('binding-missing-param', 'warning', `${who}: ${r.fqcn} needs "${name}"`, [
          ...path,
          'impl',
        ]);
    // Free-form modules (command, shell) take `_raw_params` and `cmd`; anything goes there, as do
    // set_fact's facts (AFD-222).
    if (!names.includes('free_form') && !takesFreeKeys(impl.ref))
      for (const p of params)
        if (!known.has(p))
          add('binding-unknown-param', 'warning', `${who}: ${r.fqcn} has no parameter "${p}"`, [
            ...path,
            'impl',
            'params',
            p,
          ]);
  }
  return out;
}
