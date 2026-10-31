// AFD-26: the Ansible source reader: task forms, inheritance, includes, roles, vault, folders.
import { describe, expect, it } from 'vitest';
import type { SourceIO } from '../../../src/core/import/read';
import { parseAnsible, parseConfig, relative, toValue } from '../../../src/core/import/read';
import { VAULT } from '../../../src/core/import/secrets';
import {
  type BlockForm,
  type IncludeForm,
  type Item,
  type PlayForm,
  parseKv,
  type RoleForm,
  readPlaybook,
  scanFolder,
  type TaskForm,
} from '../../../src/core/import/source';
import { fsSource, NETOPS } from './helpers';

/** A SourceIO over files in memory. */
function memory(files: Record<string, string>): SourceIO {
  return {
    async read(path) {
      return files[path];
    },
    async list(dir) {
      const prefix = dir ? `${dir}/` : '';
      const names = new Map<string, boolean>();
      for (const f of Object.keys(files))
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length).split('/');
          names.set(rest[0] as string, rest.length > 1);
        }
      return [...names].map(([name, dir]) => ({ name, dir }));
    },
  };
}

async function play(files: Record<string, string>, path = 'play.yml'): Promise<PlayForm> {
  const r = await readPlaybook(memory(files), path);
  const p = r.playbook?.plays[0];
  if (p?.kind !== 'play') throw new Error(r.notes.join('\n'));
  return p;
}

const task = (items: Item[], i: number) => items[i] as TaskForm;

describe('task forms', () => {
  it('splits k=v arguments, keeping quotes, Jinja and escapes as Ansible does', () => {
    expect(
      parseKv('src=a.j2 dest="/tmp/x y" msg="{{ a | default(\'b c\') }}" content="done\\n"'),
    ).toEqual({
      args: { src: 'a.j2', dest: '/tmp/x y', msg: "{{ a | default('b c') }}", content: 'done\n' },
      rest: '',
    });
  });

  it('reads module, free-form, action and local_action forms', async () => {
    const p = await play({
      'play.yml': `
- hosts: all
  tasks:
    - shell: ./check.sh --all chdir=/opt creates=/tmp/x
    - action: copy src=a dest=b
    - local_action:
        module: debug
        msg: hi
    - name: With args
      command: show version
      args:
        chdir: /tmp
    - cisco.ios.ios_config:
        lines: [hostname x]
    - ios_facts:
    - debug: msg="{{ x }}"
      with_items: [1, 2]
`,
    });
    expect(task(p.tasks, 0)).toMatchObject({
      fqcn: 'ansible.builtin.shell',
      params: { cmd: './check.sh --all', chdir: '/opt', creates: '/tmp/x' },
    });
    expect(task(p.tasks, 1)).toMatchObject({
      fqcn: 'ansible.builtin.copy',
      params: { src: 'a', dest: 'b' },
    });
    expect(task(p.tasks, 2)).toMatchObject({
      fqcn: 'ansible.builtin.debug',
      params: { msg: 'hi' },
      keywords: { delegate_to: 'localhost' },
    });
    expect(task(p.tasks, 3).params).toEqual({ cmd: 'show version', chdir: '/tmp' });
    expect(task(p.tasks, 4).fqcn).toBe('cisco.ios.ios_config');
    expect(task(p.tasks, 5).fqcn).toBeUndefined();
    expect(task(p.tasks, 6).keywords).toEqual({ loop: [1, 2] });
  });

  it('asks the host to resolve short names with the play collections', async () => {
    const r = await readPlaybook(
      memory({ 'p.yml': '- hosts: all\n  collections: [cisco.ios]\n  tasks:\n    - ios_facts:\n' }),
      'p.yml',
      { resolveModule: (name, cols) => `${cols[0]}.${name}` },
    );
    const p = r.playbook?.plays[0] as PlayForm;
    expect(task(p.tasks, 0).fqcn).toBe('cisco.ios.ios_facts');
  });

  it('hands play and block keywords down; when conditions are ANDed in order', async () => {
    const p = await play({
      'play.yml': `
- hosts: edge
  become: true
  become_user: admin
  vars: {a: 1}
  tasks:
    - block:
        - name: Inner
          debug: msg=x
          when: c
          tags: inner
      when: b
      tags: [outer]
      vars: {v: 2}
      any_errors_fatal: true
`,
    });
    const inner = task((p.tasks[0] as BlockForm).items, 0);
    expect(inner).toMatchObject({
      become: true,
      tags: ['outer', 'inner'],
      keywords: { become_user: 'admin', when: ['b', 'c'], vars: { v: 2 } },
    });
    expect(inner.keywords.vars).not.toHaveProperty('a');
    expect(inner.dropped).toEqual(['any_errors_fatal']);
    expect(p.vars).toEqual({ a: 1 });
  });
});

describe('includes and imports', () => {
  it('reads literal task files in, with the include keywords on their tasks', async () => {
    const p = await play(
      {
        'pb/play.yml': `
- hosts: all
  tasks:
    - name: Checks
      include_tasks: tasks/checks.yml
      when: run_checks
    - include_tasks: "{{ os }}.yml"
    - import_tasks: tasks/loop.yml
      loop: [1]
    - include_tasks: tasks/self.yml
`,
        'pb/tasks/checks.yml': '- ping:\n',
        'pb/tasks/loop.yml': '- ping:\n',
        'pb/tasks/self.yml': '- include_tasks: self.yml\n',
      },
      'pb/play.yml',
    );
    const [checks, dynamic, looped, self] = p.tasks as IncludeForm[];
    expect(checks?.path).toBe('pb/tasks/checks.yml');
    expect((checks?.items?.[0] as TaskForm | undefined)?.keywords.when).toBe('run_checks');
    expect(dynamic?.dynamic).toBe('its file name is templated');
    expect(looped?.dynamic).toBe('it runs in a loop');
    expect((self?.items?.[0] as IncludeForm | undefined)?.dynamic).toBe(
      'pb/tasks/self.yml includes itself',
    );
  });

  it('follows import_playbook and stops at a cycle', async () => {
    const r = await readPlaybook(
      memory({
        'site.yml': '- import_playbook: a.yml\n- import_playbook: missing.yml\n',
        'a.yml': '- import_playbook: site.yml\n',
      }),
      'site.yml',
    );
    const [a, missing] = r.playbook?.plays ?? [];
    expect(a?.kind === 'import_playbook' && a.playbook?.plays[0]).toMatchObject({
      kind: 'import_playbook',
      missing: 'it imports itself',
    });
    expect(missing).toMatchObject({ missing: 'missing.yml was not found or not read' });
  });

  it('reads blocks with rescue and always', async () => {
    const p = await play({
      'play.yml':
        '- hosts: all\n  tasks:\n    - block: [{ping: }]\n      rescue: [{debug: msg=r}]\n      always: [{debug: msg=a}]\n',
    });
    const b = p.tasks[0] as BlockForm;
    expect([b.items.length, b.rescue.length, b.always.length]).toEqual([1, 1, 1]);
  });
});

describe('secrets, files and roles', () => {
  it('drops vault ciphertext and skips files encrypted as a whole', async () => {
    const { value } = parseAnsible(
      'a: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6162\nb: !unsafe "{{ x }}"\n',
    );
    expect(toValue(value)).toEqual({ a: VAULT, b: '{{ x }}' });
    const r = await readPlaybook(
      memory({ 'p.yml': '$ANSIBLE_VAULT;1.1;AES256\n616263\n' }),
      'p.yml',
    );
    expect(r.playbook).toBeUndefined();
    expect(r.notes).toEqual(['p.yml is encrypted with Ansible Vault as a whole: not read.']);
  });

  it('finds local files where Ansible looks and reads vars files', async () => {
    const p = await play(
      {
        'pb/play.yml': `
- hosts: all
  vars_files: [vars/main.yml, "{{ env }}.yml"]
  tasks:
    - template: src=motd.j2 dest=/etc/motd
    - copy: {src: missing.txt, dest: /tmp}
    - script: files/run.sh --now
    - copy: {src: /abs, dest: /tmp}
`,
        'pb/templates/motd.j2': 'x',
        'pb/files/run.sh': 'x',
        'pb/vars/main.yml': 'a: 1\nb: 2\n',
      },
      'pb/play.yml',
    );
    expect(task(p.tasks, 0).files).toEqual([
      { param: 'src', written: 'motd.j2', path: 'pb/templates/motd.j2' },
    ]);
    expect(task(p.tasks, 1).files).toEqual([{ param: 'src', written: 'missing.txt' }]);
    expect(task(p.tasks, 2).files).toEqual([
      { param: 'cmd', written: 'files/run.sh', path: 'pb/files/run.sh' },
    ]);
    expect(task(p.tasks, 3).files).toEqual([]);
    expect(p.varsFiles).toEqual([
      { file: 'vars/main.yml', path: 'pb/vars/main.yml', keys: ['a', 'b'] },
      { file: '{{ env }}.yml', keys: [] },
    ]);
  });

  it('finds roles on roles_path, tells split roles, and reads what they set', async () => {
    const r = await readPlaybook(fsSource(NETOPS), 'playbooks/baseline.yml');
    const p = r.playbook?.plays[0] as PlayForm;
    expect(p.roles[0]).toMatchObject({
      kind: 'role',
      ref: 'netops_backup',
      dir: 'roles/netops_backup',
      onRolesPath: true,
      outputs: ['backup_result'],
    });
    const push = p.tasks.find((t) => t.kind === 'role') as RoleForm;
    expect(push.split?.map((s) => s.tasksFrom)).toEqual(['ntp', 'aaa']);
    expect(r.config?.rolesPath).toEqual(['roles']);
    const local = await play(
      {
        'pb/play.yml': '- hosts: all\n  roles: [own, missing, ns.coll.role]\n',
        'pb/roles/own/tasks/main.yml': '- ping:\n',
      },
      'pb/play.yml',
    );
    expect(
      local.roles.map((x) => [
        (x as RoleForm).ref,
        (x as RoleForm).dir,
        (x as RoleForm).onRolesPath,
      ]),
    ).toEqual([
      ['own', 'pb/roles/own', false],
      ['missing', undefined, false],
      ['ns.coll.role', undefined, true],
    ]);
  });

  it('looks in roles/ next to the playbook before roles_path, as Ansible does', async () => {
    const r = await readPlaybook(
      memory({
        'ansible.cfg': '[defaults]\nroles_path = roles\n',
        'pb/play.yml': '- hosts: all\n  roles: [own]\n',
        'pb/roles/own/tasks/main.yml': '- ping:\n',
        'roles/own/tasks/main.yml': '- debug:\n',
      }),
      'pb/play.yml',
    );
    const play = r.playbook?.plays[0] as PlayForm;
    const role = play.roles[0] as RoleForm;
    expect([role.dir, role.onRolesPath]).toEqual(['pb/roles/own', false]);
  });

  it('reads ansible.cfg paths relative to its folder', () => {
    expect(
      parseConfig(
        '[defaults]\nroles_path = roles:~/r:/etc/r:../shared ; c\ngathering = explicit\n',
        'repo',
      ),
    ).toMatchObject({
      rolesPath: ['repo/roles', 'shared'],
      gathering: 'explicit',
    });
    expect(relative('flows/site/generated', 'playbooks/templates/motd.j2')).toBe(
      '../../../playbooks/templates/motd.j2',
    );
  });
});

describe('folders', () => {
  it('lists playbooks with the top-level ones first, and the roles', async () => {
    const scan = await scanFolder(fsSource(NETOPS), '');
    expect(scan.playbooks.map((p) => [p.path, p.entry, p.importedBy])).toEqual([
      ['playbooks/rollback.yml', true, undefined],
      ['site.yml', true, undefined],
      ['playbooks/baseline.yml', false, 'site.yml'],
      ['playbooks/prechecks.yml', false, 'site.yml'],
    ]);
    expect(scan.roles).toEqual([
      { name: 'netops_backup', dir: 'roles/netops_backup', split: false },
      { name: 'push_baseline', dir: 'roles/push_baseline', split: true },
    ]);
  });
});
