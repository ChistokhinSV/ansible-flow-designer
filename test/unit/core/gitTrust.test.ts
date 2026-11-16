// AFD-305: git in one repository trusts a server's certificate for the server's address only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitOrigin, trustForGit, untrustedCertificate } from '../../../src/node/runner/gitTrust';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const dirs: string[] = [];
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'afd-trust-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', dir]);
  return dir;
};
const local = (dir: string) =>
  execFileSync('git', ['config', '--local', '--list'], { cwd: dir, encoding: 'utf8' });
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('trustForGit', () => {
  it('keeps the certificate in .git and names it for the address only', async () => {
    const dir = repo();
    const file = await trustForGit(dir, 'https://127.0.0.1:18443', PEM, 'linux');
    expect(file).toContain('.git');
    expect(readFileSync(file, 'utf8')).toBe(PEM);
    const config = local(dir);
    expect(config).toContain('http.https://127.0.0.1:18443/.sslcainfo=');
    // Elsewhere git keeps its own backend; only Git for Windows needs OpenSSL to read the file.
    expect(config).not.toContain('sslbackend');
    expect(config).not.toMatch(/^http\.sslcainfo/m);
  });

  it('on Windows reads the file with OpenSSL for that address', async () => {
    const dir = repo();
    await trustForGit(dir, 'https://afs.example.test', PEM, 'win32');
    expect(local(dir)).toContain('http.https://afs.example.test/.sslbackend=openssl');
    expect(existsSync(join(dir, '.git', 'afd-server-afs.example.test-443.pem'))).toBe(true);
  });

  it('a second run replaces the certificate, not adds one', async () => {
    const dir = repo();
    await trustForGit(dir, 'https://127.0.0.1:18443', PEM, 'win32');
    await trustForGit(dir, 'https://127.0.0.1:18443', PEM.replace('MIIB', 'MIIC'), 'win32');
    expect(local(dir).match(/sslcainfo/g)).toHaveLength(1);
  });
});

describe('untrustedCertificate', () => {
  it('knows git saying it does not trust the certificate', () => {
    expect(
      untrustedCertificate(
        "fatal: unable to access 'https://127.0.0.1:18443/git/lab/infra.git/': schannel: SEC_E_UNTRUSTED_ROOT (0x80090325) - The certificate chain was issued by an authority that is not trusted.",
      ),
    ).toBe(true);
    expect(untrustedCertificate('SSL certificate problem: self-signed certificate')).toBe(true);
    expect(untrustedCertificate('! [rejected] main -> main (fetch first)')).toBe(false);
  });
  it('gitOrigin is the address with a slash', () => {
    expect(gitOrigin('https://127.0.0.1:18443/some/path')).toBe('https://127.0.0.1:18443/');
  });
});
