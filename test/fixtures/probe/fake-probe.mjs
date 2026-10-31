// A stand-in for `python -m afd_probe serve` (AFD-32 tests): the same JSON-lines protocol, one
// request at a time. FAKE_CORE sets the ansible-core version on the ready line. Methods: echo
// (answers at once), sleep {ms} (answers after ms), hang (never answers), pid (this process id).
import * as readline from 'node:readline';

process.stdout.write(
  `${JSON.stringify({ kind: 'ready', probe: 'fake', ansible_core: process.env.FAKE_CORE ?? '2.19.4', python: '3.13.0', root: '/work' })}\n`,
);
const lines = readline.createInterface({ input: process.stdin });
const queue = [];
let busy = false;
const answer = (id, result) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);

function next() {
  if (busy || queue.length === 0) return;
  busy = true;
  const { id, method, params } = queue.shift();
  const done = (result) => {
    answer(id, result);
    busy = false;
    next();
  };
  if (method === 'echo') done(params ?? {});
  else if (method === 'pid') done({ pid: process.pid });
  else if (method === 'sleep') setTimeout(() => done({ slept: params.ms }), params.ms);
  else if (method === 'hang') process.stderr.write('hanging\n');
  else done({});
}

lines.on('line', (line) => {
  queue.push(JSON.parse(line));
  next();
});
lines.on('close', () => process.exit(0));
