// AFD-172: the AI integration diagnostics in whatever editor runs the suite (VS Code, or a fork
// through `just test-editor <executable> diag`); the report is kept in out/diagnostics/ per editor.
import * as assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { testApi } from './helpers';

const ROOT = join(__dirname, '../../..');

describe('AFD-172: AI integration diagnostics', () => {
  it('reports the editor, its agent APIs and the agents’ configuration', async () => {
    const report = await (await testApi()).aiDiagnostics();
    assert.match(report, /^## Editor$/m);
    assert.match(report, /- Detected: \*\*(vscode|cursor|antigravity|windsurf|kiro|other)\*\*/);
    assert.match(report, /lm\.registerTool: /);
    assert.match(report, /### Kiro/);
    const dir = join(ROOT, 'out', 'diagnostics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${vscode.env.uriScheme}-${vscode.version}.md`), report);
  });
});
