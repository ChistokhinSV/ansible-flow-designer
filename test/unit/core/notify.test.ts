// AFD-292: notify links. A step notifies handlers (by key or topic) on its level; a handler runs at
// its place, for the hosts on which a step notifying it changed something.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optionA } from '../../../src/core/engine/optionA';
import { planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { handlersNotifiedBy, notifiersOf } from '../../../src/core/flow/notify';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import { readPlaybook } from '../../../src/core/import/source';
import { fsSource } from './helpers';

const HANDLERS = join(__dirname, '../../fixtures/import/handlers');

const ID = (n: number) => `01M6GPM979RJPCDJ0XFF22G${String(n).padStart(3, '0')}`.replace(/0/g, 'A');
/** start -> config -> sshd -> restart -> done, with `config` and `sshd` notifying. */
function flow(extra: { config?: string; sshd?: string; restart?: string } = {}) {
  return `schema_version: 2
flow:
  id: 01M6GPM95NZM7QW2BDFB073CNN
  key: web
  name: Web
  version: 1
  inputs:
    devices: {type: host_list, required: true, targets: true}
nodes:
- {id: ${ID(1)}, key: start, type: start, title: Start}
- id: ${ID(2)}
  key: config
  type: task
  title: Write the web config
  impl: {kind: module, ref: ansible.builtin.template, params: {src: /etc/web.j2, dest: /etc/web.conf}}
${extra.config ?? '  notify: [restart]'}
- id: ${ID(3)}
  key: sshd
  type: task
  title: Write the sshd config
  impl: {kind: module, ref: ansible.builtin.copy, params: {content: x, dest: /etc/ssh/x}}
${extra.sshd ?? '  notify: [services changed]'}
- id: ${ID(4)}
  key: restart
  type: task
  title: Restart the services
  impl: {kind: module, ref: ansible.builtin.service, params: {name: web, state: restarted}}
${extra.restart ?? '  notified: {listen: [services changed]}'}
- {id: ${ID(5)}, key: done, type: end, title: Done, outcome: success}
edges:
- {id: ${ID(11)}, from: {node: ${ID(1)}, port: ok_hosts}, to: {node: ${ID(2)}, port: in}}
- {id: ${ID(12)}, from: {node: ${ID(2)}, port: ok_hosts}, to: {node: ${ID(3)}, port: in}}
- {id: ${ID(13)}, from: {node: ${ID(3)}, port: ok_hosts}, to: {node: ${ID(4)}, port: in}}
- {id: ${ID(14)}, from: {node: ${ID(4)}, port: ok_hosts}, to: {node: ${ID(5)}, port: in}}
`;
}
const ctx = { newId: createIdFactory() };
const docOf = (text: string) => {
  const doc = parseFlow(text).doc;
  if (!doc) throw new Error('does not parse');
  return doc;
};
const codesOf = (text: string) =>
  validateFlow(docOf(text))
    .findings.filter((f) => /notify|handler/.test(f.code))
    .map((f) => f.code);

describe('notify links', () => {
  it('reach handlers by key and by topic; a handler knows who notifies it', () => {
    const doc = docOf(flow());
    const nodes = doc.nodes;
    const [config, sshd, restart] = ['config', 'sshd', 'restart'].map(
      (k) => nodes.find((n) => n.key === k) as (typeof nodes)[number],
    );
    expect(handlersNotifiedBy(config as never, nodes).map((n) => n.key)).toEqual(['restart']);
    expect(handlersNotifiedBy(sshd as never, nodes).map((n) => n.key)).toEqual(['restart']);
    expect(notifiersOf(restart as never, nodes).map((n) => n.key)).toEqual(['config', 'sshd']);
    expect(codesOf(flow())).toEqual([]);
  });

  it('the handler runs for the hosts on which a notifying step changed something', () => {
    const out = optionA
      .generate(docOf(flow()), { source: 'web.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(out).toMatch(
      /when: "?\(config_result \| default\(\{\}\)\) is changed or \(sshd_result \| default\(\{\}\)\) is changed"?/,
    );
  });

  it('says what does not hold', () => {
    expect(codesOf(flow({ config: '  notify: [nowhere]' }))).toEqual(['notify-unknown']);
    expect(codesOf(flow({ config: '', sshd: '' }))).toEqual(['handler-unnotified']);
    // A handler before the step that notifies it.
    const before = flow({ restart: '  notified: {}\n  notify: [config-handler]' })
      .replace('  notify: [restart]', '  notified: {}')
      .replace('key: config\n', 'key: config-handler\n');
    expect(codesOf(before)).toContain('handler-not-after');
  });

  it('is set with updateNode: names cleaned, a handler marked with its topics, and cleared', () => {
    const text = flow({ config: '', sshd: '', restart: '' });
    const doc = docOf(text);
    const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
    const one = planCommand(
      text,
      {
        kind: 'updateNode',
        id: id('config'),
        patch: { notify: [' restart ', 'restart', ''] },
      },
      ctx,
    );
    const two = planCommand(
      one.text,
      {
        kind: 'updateNode',
        id: id('restart'),
        patch: { notified: { listen: ['services changed', ''] } },
      },
      ctx,
    );
    const after = docOf(two.text);
    expect(after.nodes.find((n) => n.key === 'config')?.notify).toEqual(['restart']);
    expect(after.nodes.find((n) => n.key === 'restart')?.notified).toEqual({
      listen: ['services changed'],
    });
    expect(buildModel(after)).toBeTruthy();
    const three = planCommand(
      two.text,
      {
        kind: 'updateNode',
        id: id('restart'),
        patch: { notified: null },
      },
      ctx,
    );
    expect(docOf(three.text).nodes.find((n) => n.key === 'restart')?.notified).toBeUndefined();
  });
});

describe('import', () => {
  it('turns handlers on the same level into notify links', async () => {
    const read = await readPlaybook(fsSource(HANDLERS), 'site.yml');
    if (!read.playbook) throw new Error(read.notes.join('\n'));
    const result = importPlaybook(
      read.playbook,
      { key: 'web', newId: createIdFactory(), generatedDir: 'flows/web/generated' },
      read.notes,
    );
    const nodes = result.doc.nodes;
    const by = (key: string) => nodes.find((n) => n.key === key);
    expect(by('restart-web')?.notified).toEqual({ listen: ['web settings changed'] });
    expect(by('restart-web')?.impl?.keywords?.when).toBeUndefined();
    expect(by('write-the-web-config')?.notify).toEqual(['restart-web']);
    expect(by('write-the-tls-settings')?.notify).toEqual(['restart-web']);
    const findings = validateFlow(result.doc).findings.filter((f) => /notify|handler/.test(f.code));
    expect(findings).toEqual([]);
    const code = optionA
      .generate(result.doc, { source: 'web.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(code).toContain(
      '(write_the_web_config_result | default({})) is changed or (write_the_tls_settings_result | default({})) is changed',
    );
  });
});
