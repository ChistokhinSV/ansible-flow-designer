/**
 * Where a module's full docs are (AFD-312). docs.ansible.com hosts ansible.builtin and only the
 * collections of the Ansible package, so other collections (Galaxy-only, private) got a 404 there;
 * every collection published on Ansible Galaxy has its module page, so those link there.
 */
export function moduleDocsUrl(fqcn: string): string | undefined {
  const [ns, coll, name, ...rest] = fqcn.split('.');
  if (!ns || !coll || !name || rest.length > 0) return undefined;
  if (![ns, coll, name].every((part) => /^\w+$/.test(part))) return undefined;
  if (ns === 'ansible' && coll === 'builtin')
    return `https://docs.ansible.com/ansible/latest/collections/ansible/builtin/${name}_module.html`;
  return `https://galaxy.ansible.com/ui/repo/published/${ns}/${coll}/content/module/${name}/`;
}
