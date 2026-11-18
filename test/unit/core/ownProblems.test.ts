// AFD-336: findings on a step's own Details: short, without the step's name, with a one-click fix
// where one exists; a register reused by later tasks (a normal playbook pattern) is no collision.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { type Finding, validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import { readPlaybook } from '../../../src/core/import/source';
import { ownWords, problemFix } from '../../../src/core/view/nodeProblems';

const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

// The shape of a real onboarding play: probe, act only when the probe said so, then wait with the
// same register.
const PLAYBOOK = `
- name: Onboard the appliance
  hosts: appliances
  gather_facts: false
  tasks:
    - name: Is the service up
      ansible.builtin.uri:
        url: "{{ api }}/service/info"
        status_code: [200, 404]
      register: svc_info
    - name: Restart the daemon when the service did not come up
      ansible.builtin.uri:
        url: "{{ api }}/restart"
        method: POST
      when: svc_info.status != 200
    - name: Wait until the service answers
      ansible.builtin.uri:
        url: "{{ api }}/service/info"
      register: svc_info
      until: svc_info.status == 200
      retries: 10
`;

async function imported(): Promise<string> {
  const read = await readPlaybook(
    {
      async read(path) {
        return path === 'onboard.yml' ? PLAYBOOK : undefined;
      },
      async list() {
        return [];
      },
    },
    'onboard.yml',
  );
  if (!read.playbook) throw new Error(read.notes.join('\n'));
  const r = importPlaybook(
    read.playbook,
    { key: 'onboard', newId: createIdFactory(), generatedDir: 'flows/onboard/generated' },
    read.notes,
  );
  return flowText(r.doc);
}

function findings(text: string): Finding[] {
  const doc = parse(text) as FlowDocument;
  return validateFlow(doc, schema(doc)).findings;
}

function step(text: string, title: string): FlowNode {
  for (const { node } of buildModel(parse(text) as FlowDocument).nodes.values())
    if (node.title === title) return node;
  throw new Error(`no step ${title}`);
}

describe("a step's own findings (AFD-336)", () => {
  it('a register set again after the reader is no collision', async () => {
    const text = await imported();
    const reader = step(text, 'Restart the daemon when the service did not come up');
    expect(reader.inputs?.svc_info?.from).toBe('is-the-service-up.svc_info');
    expect(findings(text).filter((f) => f.code === 'register-collision')).toEqual([]);
  });

  it('reads short, without the name, and Add as input clears it', async () => {
    let text = await imported();
    const restart = step(text, 'Restart the daemon when the service did not come up');
    const unknown = findings(text).find(
      (f) => f.code === 'binding-unknown-var' && f.node === restart.id && f.subject === 'api',
    );
    if (!unknown) throw new Error('no unknown-variable finding');
    expect(unknown.message).toContain('"Restart the daemon');
    const words = ownWords(unknown, restart);
    expect(words).toBe('Uses api, which is not an input.');
    const fix = problemFix(buildModel(parse(text) as FlowDocument), unknown);
    expect(fix?.label).toBe('Add as input');
    expect(fix?.command).toEqual({ kind: 'addOutsideInput', node: restart.id, name: 'api' });
    text = planCommand(text, fix?.command as never, ctx).text;
    const after = findings(text);
    // Set outside the flow: no step warns about api any more, and the new input is fed.
    expect(after.filter((f) => f.subject === 'api')).toEqual([]);
    expect(step(text, restart.title as string).inputs?.api).toEqual({ type: 'any' });
    expect((parse(text) as FlowDocument).flow.external_vars).toEqual({
      api: 'set outside the flow',
    });
  });

  it('without a brief, the message loses the leading name', () => {
    const node = { title: 'Check', key: 'check' };
    const f = (message: string): Finding => ({ code: 'x', severity: 'warning', message, path: [] });
    expect(ownWords(f('"Check" runs a playbook: keywords are ignored'), node)).toBe(
      'Runs a playbook: keywords are ignored',
    );
    expect(ownWords(f('Open fail port: "Check" · failed_hosts has nowhere to go'), node)).toBe(
      'Open fail port: failed_hosts has nowhere to go',
    );
  });
});
