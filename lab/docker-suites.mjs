// Runs the Docker suites on the GNS3 VM while Docker Desktop is off (decision M7-4): a snapshot of
// the working tree (tracked and untracked files, .gitignore respected) goes to /tmp/afd-ci-<stamp>
// on the VM, missing afd-ee images are built there, and lab/ci-in-container.sh runs in a
// throwaway node container with the VM's Docker socket. The folder is removed afterwards.
// Usage: node lab/docker-suites.mjs [engine] [probe] [integration]   (env: AFD_LAB_HOST, AFD_IMAGES)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = process.env.AFD_LAB_HOST ?? 'gns3';
const IMAGES = (process.env.AFD_IMAGES ?? 'afd-ee:2.19,afd-ee:2.20,afd-ee:2.21').split(',');
const NODE_IMAGE = 'node:24-bookworm';
const suites = process.argv.slice(2).join(' ') || 'engine probe integration';
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const dir = `/tmp/afd-ci-${stamp}`;

const pad = (n) => String(n).padStart(2, '0');
function log(msg) {
  const d = new Date();
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`[${t} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}] ${msg}`);
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...options });
    p.on('error', reject);
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

const ssh = (command) => run('ssh', ['-o', 'BatchMode=yes', HOST, command]);

// A tree of the working tree through a throwaway index, so uncommitted work is tested too.
const index = join(mkdtempSync(join(tmpdir(), 'afd-ci-')), 'index');
const git = (...args) =>
  execFileSync('git', args, { env: { ...process.env, GIT_INDEX_FILE: index } })
    .toString()
    .trim();
git('read-tree', 'HEAD');
git('add', '-A');
const tree = git('write-tree');
rmSync(join(index, '..'), { recursive: true, force: true });

log(`Copying the working tree (${tree.slice(0, 10)}) to ${HOST}:${dir}`);
const archive = spawn('git', ['archive', '--format=tar', tree], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const upload = spawn('ssh', ['-o', 'BatchMode=yes', HOST, `mkdir -p ${dir} && tar -x -C ${dir}`], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
archive.stdout.pipe(upload.stdin);
const copied = await new Promise((resolve) => upload.on('exit', resolve));
if (copied !== 0) throw new Error(`copy to ${HOST} failed (${copied})`);

let status = 1;
try {
  for (const image of IMAGES) {
    const core = image.split(':')[1];
    log(`Image ${image}`);
    const built = await ssh(
      `docker image inspect ${image} >/dev/null 2>&1 || docker build -q -f ${dir}/docker/afd-ee.Dockerfile --build-arg ANSIBLE_CORE=${core} -t ${image} ${dir}/docker`,
    );
    if (built !== 0) throw new Error(`building ${image} failed`);
  }
  log(`Suites: ${suites}`);
  status = await ssh(
    [
      'docker run --rm',
      '-v /var/run/docker.sock:/var/run/docker.sock',
      '-v /tmp:/tmp',
      `-w ${dir}`,
      `-e AFD_IMAGES=${IMAGES.join(',')}`,
      `-e 'AFD_SUITES=${suites}'`,
      NODE_IMAGE,
      'bash lab/ci-in-container.sh',
    ].join(' '),
  );
} finally {
  log(`Removing ${HOST}:${dir}`);
  // Files written by the container belong to root.
  await ssh(`docker run --rm -v /tmp:/tmp ${NODE_IMAGE} rm -rf ${dir}`);
}
log(`Docker suites finished with status ${status}`);
process.exit(status);
