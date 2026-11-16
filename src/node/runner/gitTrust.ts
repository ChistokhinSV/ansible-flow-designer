// AFD-305: git trusts a server's self-signed certificate in one repository. The certificate the
// server shows is kept in the repository's .git folder and named for the server's address only
// (http.<origin>/.sslCAInfo), so other remotes are untouched. Git for Windows checks certificates
// with Windows (schannel), which reads no file: for that address it uses OpenSSL instead. Git can
// also be given the token as the password of that address (git's credential helper keeps it), so
// Source Control and the terminal sign in as the designer does.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { connect } from 'node:tls';
import { type GitAuth, git, ProjectGitError } from './projectGit';

export interface ServerCertificate {
  pem: string;
  subject: string;
  issuer: string;
  /** SHA-256 of the certificate, as `AB:CD:…` (what the server's certificate page shows). */
  fingerprint: string;
  validTo: string;
}

/** The certificate the server at `url` shows, whoever signed it. */
export function serverCertificate(url: string, timeoutMs = 10_000): Promise<ServerCertificate> {
  const { hostname, port } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  return new Promise((done, fail) => {
    const socket = connect(
      {
        host,
        port: Number(port || 443),
        // Read only: the certificate is shown to the person, who decides.
        rejectUnauthorized: false,
        ...(/^[\d.:]+$/.test(host) ? {} : { servername: host }),
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.raw) return fail(new ProjectGitError(`${url} showed no certificate`));
        const b64 =
          cert.raw
            .toString('base64')
            .match(/.{1,64}/g)
            ?.join('\n') ?? '';
        const hex = createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
        done({
          pem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
          subject: String(cert.subject?.CN ?? ''),
          issuer: String(cert.issuer?.CN ?? ''),
          fingerprint: hex.match(/.{2}/g)?.join(':') ?? hex,
          validTo: cert.valid_to,
        });
      },
    );
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`${url} did not answer`)));
    socket.on('error', (e) => fail(new ProjectGitError(e.message)));
  });
}

/** `https://host:port/`: the key git's settings for one address are named with. */
export const gitOrigin = (url: string) => `${new URL(url).origin}/`;

/**
 * Keeps the certificate in the repository's .git folder and tells git to trust it for the server's
 * address only. Answers the file it wrote.
 */
export async function trustForGit(
  folder: string,
  url: string,
  pem: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const gitDir = await git(folder, ['rev-parse', '--absolute-git-dir']);
  const { hostname, port } = new URL(url);
  const file = join(gitDir, `afd-server-${hostname.replace(/[^\w.-]/g, '_')}-${port || 443}.pem`);
  writeFileSync(file, pem);
  const at = `http.${gitOrigin(url)}`;
  await git(folder, ['config', '--local', `${at}.sslCAInfo`, file.split(sep).join('/')]);
  if (platform === 'win32') await git(folder, ['config', '--local', `${at}.sslBackend`, 'openssl']);
  return file;
}

/** True when git reaches the server's repository with its own settings (no certificate skip). */
export async function gitReaches(folder: string, remoteUrl: string, token: string): Promise<void> {
  await git(folder, ['ls-remote', '--heads', remoteUrl], { token, verifyTls: true } as GitAuth);
}

/** True when git has a credential helper to keep a password with. */
export async function hasCredentialHelper(folder: string): Promise<boolean> {
  return !!(await git(folder, ['config', '--get', 'credential.helper']).catch(() => ''));
}

/** Gives git's credential helper the token as the password of the server's address. */
export function storeGitCredential(folder: string, url: string, token: string): Promise<void> {
  const { protocol, host } = new URL(url);
  return new Promise((done, fail) => {
    const child = spawn('git', ['credential', 'approve'], {
      cwd: folder,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let said = '';
    child.stderr.on('data', (d) => {
      said += String(d);
    });
    child.on('error', (e) => fail(new ProjectGitError(e.message)));
    child.on('close', (code) =>
      code === 0
        ? done()
        : fail(new ProjectGitError(said.split(token).join('***').trim() || `git said ${code}`)),
    );
    // The server takes a token as the password with any user name.
    child.stdin.end(
      `protocol=${protocol.replace(':', '')}\nhost=${host}\nusername=afd\npassword=${token}\n\n`,
    );
  });
}

/** True when git failed because it does not trust the server's certificate. */
export const untrustedCertificate = (message: string) =>
  /SEC_E_UNTRUSTED_ROOT|self[- ]signed certificate|certificate verify failed|unable to get local issuer|server certificate verification failed|CERT_TRUST|not trusted/i.test(
    message,
  );
