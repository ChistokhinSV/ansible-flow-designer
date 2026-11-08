// AFD-125, the Low tickets (AFD-158..166): small findings of the 0.74.1 code review, each kept as
// a regression test.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MAX_QUERY_WORDS, planQuery } from '../../../src/core/catalog/rank';
import { collectionFile } from '../../../src/core/catalog/shape';
import { scanPaths } from '../../../src/core/drift/drift';
import { attr } from '../../../src/core/export/drawio';
import { xmlClean } from '../../../src/core/export/xml';
import { testedFinding } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { privilegeOf } from '../../../src/core/flow/inherit';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { RESERVED_NAMES, varNameProblem } from '../../../src/core/flow/varNames';
import { GIT_REF, messageProblem } from '../../../src/core/messageCheck';
import { runProcess } from '../../../src/core/run/command';
import {
  checkScenarios,
  type Scenario,
  scenarioInventory,
  scenarioVars,
} from '../../../src/core/scenario/scenarios';
import { removeItem, removeItems } from '../../../src/core/yaml/ops';
import { renderScalar } from '../../../src/core/yaml/render';
import { YamlEditError, YamlTransaction } from '../../../src/core/yaml/transaction';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import { AwxClient, AwxError } from '../../../src/node/awx/client';
import { junitDocument, junitSuite, runScenarios } from '../../../src/node/scenario/runner';
import { readExample } from './helpers';

const ESC = String.fromCharCode(0x1b);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);

describe('AFD-158: output files are valid', () => {
  it('JUnit: several flows under one root, without control characters', () => {
    const result = { name: 'n', passed: false, hosts: [], forced: [], error: `${ESC}[31mred` };
    const doc = junitDocument([
      junitSuite('a', [result as never]),
      junitSuite('b', [{ ...result, passed: true } as never]),
    ]);
    expect(doc.match(/<\?xml/g)).toHaveLength(1);
    expect(doc.match(/<testsuites>/g)).toHaveLength(1);
    expect(doc.match(/<testsuite /g)).toHaveLength(2);
    expect(doc).not.toContain(ESC);
    expect(doc).toContain('[31mred');
  });

  it('exports: forbidden controls go, tabs and returns stay as references, any value is text', () => {
    expect(xmlClean(`a${ESC}b${String.fromCharCode(0)}c`)).toBe('abc');
    expect(xmlClean(7)).toBe('7');
    expect(xmlClean(undefined)).toBe('');
    expect(attr('a\tb\r\nc"<')).toBe('a&#9;b&#13;&#10;c&quot;&lt;');
    expect(attr(3)).toBe('3');
  });

  it('flow files: line breaks PyYAML knows and C1 controls are double-quoted and escaped', () => {
    for (const s of [`a${NEL}b`, `a${LS}b`, `del${String.fromCharCode(0x7f)}`]) {
      const out = renderScalar(s);
      expect(out.startsWith('"')).toBe(true);
      expect(out).not.toContain(NEL);
      expect(out).not.toContain(LS);
      expect(parse(`k: ${out}`).k).toBe(s);
    }
    expect(renderScalar('plain text')).toBe('plain text');
  });
});

describe('AFD-159: scenarios stay on this machine, and bad files do not crash', () => {
  const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
  const base = { name: 's', inputs: { devices: ['h1'] }, expect: { h1: 'done' } };
  const messages = (scenarios: unknown[]) =>
    checkScenarios(doc, { scenarios: scenarios as Scenario[] }).map((p) => p.message);

  it('a name that would add an inventory line is refused, and never written', () => {
    const evil = 'x\nevil ansible_connection=ssh ansible_host=192.0.2.5';
    expect(messages([{ ...base, groups: { web: [evil] } }]).join('\n')).toContain(
      'is not a host name',
    );
    expect(messages([{ ...base, groups: { 'web]\n[x': ['h1'] } }]).join('\n')).toContain(
      'is not a group name',
    );
    expect(messages([{ ...base, inputs: { devices: ['h1 ansible_host=192.0.2.5'] } }])).toEqual(
      expect.arrayContaining([expect.stringContaining('is not a host name')]),
    );
    expect(() => scenarioInventory(doc, { ...base, groups: { web: [evil] } })).toThrow();
    expect(scenarioInventory(doc, { ...base, groups: { web: ['h1'] } })).toContain('[web]');
  });

  it('inputs cannot set ansible_* variables, which outrank the local connection', () => {
    const s = { ...base, inputs: { ...base.inputs, ansible_connection: 'ssh', site: 'x' } };
    expect(messages([s]).join('\n')).toContain('ansible_connection: a scenario runs');
    expect(scenarioVars(s)).not.toHaveProperty('ansible_connection');
    expect(scenarioVars(s)).toHaveProperty('site', 'x');
  });

  it('an empty entry, a name that is no text or a list where a map goes is a problem', () => {
    expect(messages([null])).toEqual(['A scenario is a map: name, inputs, force, expect']);
    expect(messages([{ ...base, name: 7 }])).toContain('A scenario name is text');
    expect(messages([{ ...base, groups: ['h1'] }])).toContain('groups is a map');
  });

  it('the runner skips an entry that is no map and stages a numeric name', async () => {
    const work = mkdtempSync(join(tmpdir(), 'afd-low-'));
    try {
      const results = await runScenarios({
        env: { kind: 'local', python: 'python3', source: 'afd', label: 'local' },
        root: work,
        probeDir: work,
        flowFile: join(work, 'x.flow.yaml'),
        // No nodes: the flow does not generate, so nothing runs.
        doc: { ...doc, nodes: [], edges: [] } as unknown as FlowDocument,
        file: { scenarios: [null, { ...base, name: 7 }] as unknown as Scenario[] },
        workDir: work,
      });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ name: 7, passed: false });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('a container run writes its events into a folder of their own', () => {
    const spec = runProcess(
      {
        kind: 'container',
        engine: 'docker',
        image: 'ee',
        options: [],
        mounts: [],
        source: 'afd',
        label: 'ee',
      },
      { root: '/repo', probe: '/probe' },
      {
        playbook: '/afd-run/x.yml',
        check: false,
        runDir: '/tmp/run',
        vault: false,
        hasConfig: false,
        eventsDir: 'events',
      },
      'n',
    );
    expect(spec.args).toContain('AFD_EVENTS=/afd-run/events/events.jsonl');
  });

  it('a flow with an alias bomb does not read, and does not throw', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 12; i++)
      lines.push(
        `${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [${Array(10)
          .fill(`*${String.fromCharCode(96 + i)}`)
          .join(', ')}]`,
      );
    const parsed = parseFlow(lines.join('\n'));
    expect(parsed.doc).toBeUndefined();
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe('AFD-160: names, upgrades and list removals', () => {
  const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
  const flowSchema = JSON.parse(
    readFileSync(join(__dirname, '../../../schema/flow.schema.json'), 'utf8'),
  );

  it('a name Ansible or Jinja cannot read as a variable is refused', () => {
    for (const bad of ['retry-count', 'web servers', '1st', 'in', 'not', 'true', 'none', 'class'])
      expect(varNameProblem(bad), bad).toBeDefined();
    for (const good of ['retries', '_x', 'web_servers', 'In', 'match'])
      expect(varNameProblem(good)).toBeUndefined();
    // The schema carries the same list, for editors that read it alone.
    const names = flowSchema.$defs.contract.propertyNames;
    expect([...names.not.enum].sort()).toEqual([...RESERVED_NAMES].sort());
    expect(names.pattern).toBe('^[A-Za-z_][A-Za-z0-9_]*$');
  });

  it('the validator reports bad input and output names once, schema or not', () => {
    const bad = structuredClone(doc) as FlowDocument & {
      flow: { inputs: Record<string, unknown> };
    };
    bad.flow.inputs['web-servers'] = { type: 'string' };
    const node = bad.nodes[0] as FlowNode;
    node.outputs = { not: { type: 'string' } };
    const found = validateFlow(bad, createSchemaValidator()(bad)).findings.filter((f) =>
      /web-servers|"not"/.test(f.message),
    );
    expect(found.map((f) => f.code)).toEqual(['bad-name', 'bad-name']);
  });

  it('become_user without become still says whom to become; become: false turns it off', () => {
    const v2 = { ...structuredClone(doc), schema_version: 2 } as FlowDocument;
    const node = v2.nodes[0] as FlowNode;
    node.settings = { become_user: 'deploy' };
    expect(privilegeOf(buildModel(v2), node)).toEqual({ become_user: 'deploy' });
    node.settings = { become_user: 'deploy', become: false };
    expect(privilegeOf(buildModel(v2), node)).toEqual({});
    node.settings = { become: true };
    expect(privilegeOf(buildModel(v2), node)).toEqual({ become: true });
  });

  it('the upgrade says when a node marked tested by hand loses the mark', () => {
    const v1 = structuredClone(doc);
    const node = [...v1.nodes].find((n) => n?.status === 'draft' && !n.impl) as FlowNode;
    node.status = 'tested';
    v1.decisions = [
      ...(v1.decisions ?? []),
      { kind: 'finding_accepted', finding: testedFinding(node.id), reason: 'checked by hand' },
    ] as FlowDocument['decisions'];
    const notes = upgradeNotes(v1).join(' | ');
    expect(notes).toContain('marked tested by hand is not implemented');
    expect(notes).toContain(node.title);
  });

  it('several items of a flow-style list go in one batch', () => {
    const lines = (...l: string[]) =>
      `${l.join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
    const tx = new YamlTransaction(lines('a: [1, 2, 3, 4]', 'b: [x]'));
    tx.applyAll([(f) => removeItems(f, ['a'], [0, 2]), (f) => removeItems(f, ['b'], [])]);
    expect(tx.text).toBe(lines('a: [2, 4]', 'b: [x]'));
    const block = new YamlTransaction(lines('a:', '  - 1', '  - 2', '  - 3'));
    block.apply((f) => removeItems(f, ['a'], [2, 0]));
    expect(block.text).toBe(lines('a:', '  - 2'));
    // Two ops on one region are an edit error the commands report, not a plain Error.
    const both = new YamlTransaction(lines('a: [1, 2, 3]'));
    expect(() =>
      both.applyAll([(f) => removeItem(f, ['a'], 0), (f) => removeItem(f, ['a'], 2)]),
    ).toThrow(YamlEditError);
  });
});

describe('AFD-161: the AWX token travels safely', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url?.startsWith('/loop'))
        res.end(JSON.stringify({ results: [1], next: '/loop/?page=2' }));
      else if (req.url?.startsWith('/big')) res.end(JSON.stringify({ blob: 'x'.repeat(5000) }));
      else if (req.url?.startsWith('/slow')) {
        // A byte every 50 ms: never idle long enough for the idle timeout.
        const t = setInterval(() => res.write(' '), 50);
        req.on('close', () => clearInterval(t));
      } else res.end(JSON.stringify({ version: '24.6.1' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('plain http to another machine is refused before anything is sent; this machine is fine', async () => {
    await expect(new AwxClient('http://192.0.2.10:30080', 't').ping()).rejects.toThrow(
      /unencrypted.*allowHttp/,
    );
    expect(await new AwxClient(base, 't').ping()).toEqual({ version: '24.6.1' });
  });

  it('a page that leads back, an answer too big and a slow trickle all end', async () => {
    const awx = new AwxClient(base, 't', { maxBodyBytes: 1000, deadlineMs: 400 });
    await expect(awx.all('/loop/')).rejects.toThrow(/lead back/);
    await expect(awx.get('/big/')).rejects.toThrow(/more than 1000 bytes/);
    const slow = awx.get('/slow/');
    await expect(slow).rejects.toBeInstanceOf(AwxError);
    await expect(slow).rejects.toThrow(/did not finish/);
  });
});

describe('AFD-163: the catalog survives odd files and long queries', () => {
  it('a JSON file that is no dump is skipped; a bad plugin goes, the others stay', () => {
    expect(collectionFile({ hello: 'world' })).toBeUndefined();
    expect(collectionFile([1, 2])).toBeUndefined();
    const file = collectionFile({
      collection: 'ns.coll',
      version: '1.0.0',
      plugins: [
        { type: 'module', fqcn: 'ns.coll.a', name: 'a', collection: 'ns.coll' },
        { type: 'module', name: 'no_fqcn' },
        null,
        {
          type: 'module',
          fqcn: 'ns.coll.b',
          name: 'b',
          collection: 'ns.coll',
          description: ['line one', 'line two'],
          options: { x: { description: ['opt'] }, y: null },
        },
      ],
    });
    expect(file?.plugins.map((p) => p.name)).toEqual(['a', 'b']);
    expect(file?.plugins[0]?.description).toBe('');
    expect(file?.plugins[1]?.description).toBe('line one line two');
    expect(file?.plugins[1]?.options?.x?.description).toBe('opt');
    expect(file?.plugins[1]?.options?.y?.description).toBe('');
    expect(file?.routing).toEqual({});
  });

  it('a query keeps at most 30 words, so the coverage bits fit', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(planQuery(words).words).toHaveLength(MAX_QUERY_WORDS);
    expect(MAX_QUERY_WORDS).toBeLessThanOrEqual(31);
  });
});

describe('AFD-165: what the designer and the AI tools send is checked', () => {
  it('message shapes: refs are no git options, plugin names no paths', () => {
    const doc = (fqcn: string) => ({ type: 'catalog', reqId: 1, request: { op: 'doc', fqcn } });
    expect(messageProblem('x')).toBeDefined();
    expect(messageProblem({ type: 'compareWith', ref: '--output=/tmp/x' })).toBeDefined();
    expect(messageProblem({ type: 'compareWith', ref: 'main' })).toBeUndefined();
    expect(messageProblem({ type: 'compareWith', ref: 'outside' })).toBeUndefined();
    expect(GIT_REF.test('a1b2c3d4')).toBe(true);
    expect(messageProblem(doc('../x'))).toBeDefined();
    expect(messageProblem(doc('ansible.builtin.copy'))).toBeUndefined();
    expect(messageProblem({ type: 'openCode', path: 7 })).toBeDefined();
    expect(messageProblem({ type: 'openText', path: ['nodes', 0, 'title'] })).toBeUndefined();
    expect(messageProblem({ type: 'ready' })).toBeUndefined();
  });

  it('Open Code outside the workspace only for files the scan named', () => {
    const outside = '/usr/share/ansible/r/tasks/main.yml';
    const scan = {
      generated: { path: 'flows/x/generated/x.yml', plays: [{ origin: { path: outside } }] },
    };
    const paths = scanPaths(scan as never);
    expect(paths.has(outside)).toBe(true);
    expect(paths.has('flows/x/generated/x.yml')).toBe(true);
    expect(scanPaths(undefined).size).toBe(0);
  });

  it('MCP errors name files relative to the root, and the home folder as ~', () => {
    const root = mkdtempSync(join(tmpdir(), 'afd-mcp-'));
    try {
      const io = new FsFlowIO([root], createSchemaValidator(), createIdFactory());
      const file = join(root, 'flows', 'x.flow.yaml');
      const shown = io.hidePaths(`ENOENT: no such file or directory, open '${file}'`);
      expect(shown).not.toContain(root);
      expect(shown).toContain('x.flow.yaml');
      expect(io.hidePaths(`at ${join(homedir(), 'other')}`)).toBe(`at ${join('~', 'other')}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
