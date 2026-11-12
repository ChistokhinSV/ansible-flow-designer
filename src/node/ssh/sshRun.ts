// AFD-247: starts a run's `ssh` with the run's secrets on its input. A run is a VS Code task, and
// a task's process gets its input from the terminal; ssh passes no environment to the host. So
// the task runs this instead: it takes the secret values from its own environment, writes each as
// one base64 line to ssh's input, and from then on is ssh (its output, its exit code, its
// signals). The values are never arguments, on this machine or on the host.
//
// Usage: afd-ssh-run <NAME>[,<NAME>…] <ssh> <ssh arguments…>
import { spawn } from 'node:child_process';

const [names = '', command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('afd-ssh-run: nothing to run\n');
  process.exit(2);
}
const child = spawn(command, args, { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
child.on('error', (e) => {
  process.stderr.write(`Could not start ${command}: ${e.message}\n`);
  process.exit(127);
});
child.stdin?.on('error', () => undefined);
for (const name of names.split(',').filter(Boolean)) {
  const value = process.env[name] ?? '';
  child.stdin?.write(`${Buffer.from(value, 'utf8').toString('base64')}\n`);
}
child.stdin?.end();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.on(signal, () => child.kill(signal));
child.on('close', (code, signal) => process.exit(code ?? (signal ? 143 : 1)));
