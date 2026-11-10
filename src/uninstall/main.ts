// Entry of `vscode:uninstall` (package.json scripts), bundled to dist/uninstall.js (AFD-202).
import { spawn } from 'node:child_process';
import { processEnv, runUninstall } from './uninstall';

runUninstall(processEnv(__dirname), (cmd, args) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
});
