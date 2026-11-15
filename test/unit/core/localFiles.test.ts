// AFD-291: a relative file a step reads (template src, copy src, a script, a vars file) is the
// repository's: the generator writes it from {{ afd_repo_root }}, which the generated play sets,
// and the host warns when the file is not in the repository.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { optionA } from '../../../src/core/engine/optionA';
import { parseFlow } from '../../../src/core/flow/document';
import { localFileOf, rootedParams } from '../../../src/core/flow/localFiles';
import { repoFileFindings } from '../../../src/node/repoFiles';

describe('files a step reads from the repository', () => {
  it('names a relative, untemplated path of a file-reading module only', () => {
    expect(localFileOf('ansible.builtin.template', { src: 'templates/motd.j2' })).toEqual({
      param: 'src',
      path: 'templates/motd.j2',
    });
    expect(localFileOf('copy', { src: './files/hello.txt', dest: '/x' })?.path).toBe(
      'files/hello.txt',
    );
    expect(localFileOf('ansible.builtin.script', { cmd: 'scripts/check.sh --fast' })).toEqual({
      param: 'cmd',
      path: 'scripts/check.sh',
    });
    expect(localFileOf('include_vars', { file: 'vars/site.yml' })?.path).toBe('vars/site.yml');
    // Not a repository file: absolute, templated, remote, another module.
    expect(localFileOf('template', { src: '/etc/motd.j2' })).toBeUndefined();
    expect(localFileOf('template', { src: '{{ afd_repo_root }}/t.j2' })).toBeUndefined();
    expect(localFileOf('copy', { src: 'a.txt', remote_src: true })).toBeUndefined();
    expect(localFileOf('copy', { content: 'x', dest: '/x' })).toBeUndefined();
    expect(localFileOf('ansible.builtin.debug', { msg: 'templates/x' })).toBeUndefined();
  });

  it('writes it from afd_repo_root, keeping a script its arguments', () => {
    expect(rootedParams('template', { src: 'templates/motd.j2', dest: '/etc/motd' })).toEqual({
      src: '{{ afd_repo_root }}/templates/motd.j2',
      dest: '/etc/motd',
    });
    expect(rootedParams('script', { cmd: 'scripts/check.sh --fast' })).toEqual({
      cmd: '{{ afd_repo_root }}/scripts/check.sh --fast',
    });
    const absolute = { src: '/etc/motd.j2' };
    expect(rootedParams('template', absolute)).toBe(absolute);
  });

  it('the generated play sets afd_repo_root and the task reads the file from it', () => {
    const text = `schema_version: 2
flow:
  id: 01M6GPM95NZM7QW2BDFB073CNN
  key: motd
  name: MOTD
  version: 1
  inputs:
    devices: {type: host_list, required: true, targets: true}
nodes:
- {id: 01M6GPM95RHBYFR7H44Z8GD2HB, key: start, type: start, title: Start}
- {id: 01M6GPM95RHBYFR7H44Z8GD2HC, key: done, type: end, title: Done, outcome: success}
- id: 01M6GPM979RJPCDJ0XFF22GBSV
  key: motd
  type: task
  title: Write the MOTD
  status: implemented
  impl: {kind: module, ref: ansible.builtin.template, params: {src: templates/motd.j2, dest: /etc/motd}}
edges:
- {id: 01M6GPM95RHBYFR7H44Z8GD2HD, from: {node: 01M6GPM95RHBYFR7H44Z8GD2HB, port: ok_hosts}, to: {node: 01M6GPM979RJPCDJ0XFF22GBSV, port: in}}
- {id: 01M6GPM97W4B2AMEW6HFHXRBCG, from: {node: 01M6GPM979RJPCDJ0XFF22GBSV, port: ok_hosts}, to: {node: 01M6GPM95RHBYFR7H44Z8GD2HC, port: in}}
`;
    const doc = parseFlow(text).doc;
    if (!doc) throw new Error('does not parse');
    const out = optionA
      .generate(doc, { source: 'motd.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(out).toContain('src: "{{ afd_repo_root }}/templates/motd.j2"');
    expect(out).toContain(
      'afd_repo_root: "{{ (playbook_dir ~ \'/../../..\') | ansible.builtin.realpath }}"',
    );
  });
});

describe('a missing repository file is a warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'afd-localfiles-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('warns for a relative or rooted path that is not there; not for one that is', () => {
    mkdirSync(join(root, 'templates'));
    writeFileSync(join(root, 'templates', 'motd.j2'), 'x\n');
    const node = (key: string, ref: string, params: Record<string, unknown>) =>
      `- id: 01M6GPM979RJPCDJ0XFF22G${key}
  key: s-${key.toLowerCase()}
  type: task
  title: Step ${key}
  impl: {kind: module, ref: ${ref}, params: ${JSON.stringify(params)}}`;
    const text = `schema_version: 2
flow: {id: 01M6GPM95NZM7QW2BDFB073CNN, key: f, name: F, version: 1}
nodes:
${node('BSA', 'template', { src: 'templates/motd.j2', dest: '/x' })}
${node('BSB', 'template', { src: 'templates/gone.j2', dest: '/x' })}
${node('BSC', 'copy', { src: '{{ afd_repo_root }}/files/gone.txt', dest: '/x' })}
${node('BSD', 'copy', { src: 'gone.txt', dest: '/x', remote_src: true })}
edges: []
`;
    const doc = parseFlow(text).doc;
    if (!doc) throw new Error('does not parse');
    const found = repoFileFindings(doc, root);
    expect(found.map((f) => [f.code, f.message])).toEqual([
      [
        'binding-file-missing',
        '"Step BSB" reads templates/gone.j2, which is not in the repository: a relative path is from the repository root when the flow runs',
      ],
      [
        'binding-file-missing',
        '"Step BSC" reads files/gone.txt, which is not in the repository: a relative path is from the repository root when the flow runs',
      ],
    ]);
    expect(repoFileFindings(doc)).toEqual([]);
  });
});
