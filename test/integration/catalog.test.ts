// M5 acceptance inside VS Code: catalog requests as the properties page sends them, Save binding as
// one undo step, generated code with data passing, catalog-backed binding diagnostics, and (with
// AFD_TEST_IMAGE) the real catalog the probe dumps in the Docker image.
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { CollectionFile, SearchHit } from '../../src/core/catalog/types';
import type { FlowDocument } from '../../src/core/flow/types';
import type { CatalogDoc, CatalogStatus } from '../../src/core/protocol';
import { sqliteAvailable } from '../../src/node/catalog/catalogIndex';
import { closeAll, flowUri, openDesigner, runEnvironment, testApi, withTimeout } from './helpers';

const EDGE = flowUri('edge-baseline');
const image = runEnvironment;
const FIXTURES = join(__dirname, '../../../test/fixtures/catalog/files');
const files = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as CollectionFile);
const docOf = (text: string) => parse(text) as FlowDocument;
const idOf = (text: string, key: string) =>
  docOf(text).nodes.find((n) => n.key === key)?.id as string;

/** Diagnostics with this code, once the snapshot for the current version is in. */
async function codes(uri: vscode.Uri): Promise<string[]> {
  const api = await testApi();
  const doc = await vscode.workspace.openTextDocument(uri);
  await withTimeout(api.rendered(uri, doc.version), 20_000, 'render');
  return api.diagnostics(uri).map((d) => String(d.code));
}

describe('M5 acceptance: catalog and binding', () => {
  // AFD-171: no node:sqlite on the engine floor (Node 20): the catalog is off there.
  before(function () {
    if (!sqliteAvailable()) this.skip();
  });

  afterEach(closeAll);

  it('answers the page: search, docs through redirects, playbooks', async () => {
    await openDesigner(EDGE);
    const api = await testApi();
    api.useCatalog(EDGE, files);
    const hits = (await api.catalog(EDGE, {
      op: 'search',
      query: 'configuration sections ios',
      types: ['module'],
    })) as SearchHit[];
    assert.equal(hits[0]?.fqcn, 'cisco.ios.ios_config', JSON.stringify(hits.map((h) => h.fqcn)));
    const doc = (await api.catalog(EDGE, { op: 'doc', fqcn: 'ios_config' })) as CatalogDoc;
    assert.equal(doc.fqcn, 'cisco.ios.ios_config');
    assert.equal(doc.collection_version, '9.0.3');
    assert.ok(Array.isArray(await api.catalog(EDGE, { op: 'playbooks' })));
    assert.equal(api.catalogStatus(EDGE)?.state, 'ready');
  });

  it('Save binding is one undo step; saved code passes data and the catalog checks it', async () => {
    const doc = await openDesigner(EDGE);
    const api = await testApi();
    api.useCatalog(EDGE, files);
    const original = doc.getText();
    const backup = idOf(original, 'backup-config');
    const validate = idOf(original, 'validate');
    const bind = await api.run(EDGE, {
      kind: 'setBinding',
      id: backup,
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_config',
        collection_version: '9.0.3',
        params: { backup: true, nonsense: 1 },
        register: 'backup_out',
      },
      outputs: { backup_ref: { type: 'string', from: 'impl.register.backup_path' } },
    });
    assert.ok(bind.ok, bind.error);
    const bound = docOf(doc.getText()).nodes.find((n) => n.id === backup);
    assert.equal(bound?.impl?.ref, 'cisco.ios.ios_config');
    assert.ok((await codes(EDGE)).includes('binding-unknown-param'), 'unknown parameter reported');

    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), original, 'one undo step restores the document');
    await vscode.commands.executeCommand('redo');

    const read = await api.run(EDGE, {
      kind: 'setContractField',
      target: validate,
      side: 'inputs',
      name: 'baseline',
      field: { type: 'string', from: 'backup-config.backup_ref' },
    });
    assert.ok(read.ok, read.error);
    await vscode.commands.executeCommand('workbench.action.files.save');
    const outcome = await withTimeout(
      api.savedCode(EDGE) ?? Promise.reject(new Error('no codegen')),
      20_000,
      'codegen',
    );
    assert.ok(outcome.ok, outcome.error);
    const generated = readFileSync(
      vscode.Uri.joinPath(EDGE, '..', 'generated', 'edge-baseline.yml').fsPath,
      'utf8',
    );
    const plays = parse(generated) as {
      name: string;
      vars?: Record<string, string>;
      tasks?: unknown[];
    }[];
    const backupPlay = plays.find((p) => p.name.startsWith('[backup-config]'));
    assert.ok(JSON.stringify(backupPlay?.tasks).includes('"cisco.ios.ios_config"'));
    assert.ok(JSON.stringify(backupPlay?.tasks).includes('"register":"backup_out"'));
    const validatePlay = plays.find((p) => p.name.startsWith('[validate]'));
    assert.equal(validatePlay?.vars?.baseline, '{{ backup_out.backup_path }}');

    // Restore the repository for the other suites.
    await api.run(EDGE, { kind: 'setBinding', id: backup, impl: null });
    await vscode.workspace.fs.writeFile(EDGE, new TextEncoder().encode(original));
  });

  it('reports bindings the environment does not have', async () => {
    const doc = await openDesigner(EDGE);
    const api = await testApi();
    api.useCatalog(EDGE, files);
    const backup = idOf(doc.getText(), 'backup-config');
    const r = await api.run(EDGE, {
      kind: 'setBinding',
      id: backup,
      impl: { kind: 'module', ref: 'vendor.absent.not_here' },
    });
    assert.ok(r.ok, r.error);
    assert.ok((await codes(EDGE)).includes('binding-not-in-ee'));
  });

  (image ? it : it.skip)(
    `dumps and indexes the real catalog of ${image ?? 'AFD_TEST_IMAGE'}`,
    async function () {
      this.timeout(15 * 60_000);
      await openDesigner(EDGE);
      const api = await testApi();
      const status = (await api.catalog(EDGE, { op: 'rebuild' })) as CatalogStatus;
      assert.equal(status.state, 'ready', status.message);
      assert.ok((status.modules ?? 0) > 50, JSON.stringify(status));
      const hits = (await api.catalog(EDGE, {
        op: 'search',
        query: 'ping',
        types: ['module'],
      })) as SearchHit[];
      assert.ok(
        hits.slice(0, 3).some((h) => h.fqcn === 'ansible.builtin.ping'),
        JSON.stringify(hits.slice(0, 5).map((h) => h.fqcn)),
      );
    },
  );
});
