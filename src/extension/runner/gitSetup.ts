// AFD-305: Set Up Git for the Server: git in this folder trusts the connected server's certificate
// (for the server's address only), and may be given the token to sign in with, so pulls and pushes
// from Source Control and the terminal work against a lab server with a self-signed certificate.
import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
  gitOrigin,
  gitReaches,
  hasCredentialHelper,
  serverCertificate,
  storeGitCredential,
  trustForGit,
  untrustedCertificate,
} from '../../node/runner/gitTrust';
import { nestedRepoOf } from '../../node/runner/nestedRepos';
import { repositoryOf, upstreamOf } from '../../node/runner/projectGit';
import { CANCELLED, isCancelled } from '../errors';
import { config, tokenKey } from './connect';

export async function setUpGit(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<string | undefined> {
  const { url } = config(scope);
  if (!url) return 'Connect to Ansible Flow Server first';
  if (new URL(url).protocol !== 'https:') return `${url} is not https: git needs no certificate`;
  const top = vscode.workspace.getWorkspaceFolder(scope)?.uri.fsPath;
  if (!top) return 'Open the folder of flows first';
  // AFD-324: a repository inside the workspace folder is set up, not the folder above it.
  const folder = (scope.scheme === 'file' && nestedRepoOf(scope.fsPath, top)) || top;
  if ((await repositoryOf(folder)) === 'none')
    return 'This folder is not a git repository: get the flows from the server first';
  return setUpGitIn(folder, url, secrets);
}

/**
 * AFD-323: whether git in the repository `folder` refuses the server's certificate when it reaches
 * the server's git address (its upstream, when that is on the server). Undefined: nothing to ask
 * (not https, no remote on the server, no token, or another failure that is not the certificate).
 */
export async function gitRefusesServer(
  folder: string,
  url: string,
  secrets: vscode.SecretStorage,
): Promise<boolean | undefined> {
  if (new URL(url).protocol !== 'https:') return undefined;
  const token = await secrets.get(tokenKey(url));
  const up = await upstreamOf(folder).catch(() => undefined);
  if (!token || !up || new URL(up.url).host !== new URL(url).host) return undefined;
  try {
    await gitReaches(folder, up.url, token);
    return false;
  } catch (e) {
    return untrustedCertificate((e as Error).message) ? true : undefined;
  }
}

/**
 * AFD-323: after Connect, Get the Project's Flows or a new folder from Change Project: when git
 * there refuses the server's certificate, offer to trust it for this repository (the same
 * question as Set Up Git for the Server), so Source Control pulls and pushes as well.
 */
export async function offerGitTrust(
  folder: string,
  url: string,
  secrets: vscode.SecretStorage,
): Promise<void> {
  if ((await gitRefusesServer(folder, url, secrets)) !== true) return;
  const error = await setUpGitIn(folder, url, secrets);
  if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
}

/** Set Up Git for the Server in the repository `folder` (see setUpGit). */
export async function setUpGitIn(
  folder: string,
  url: string,
  secrets: vscode.SecretStorage,
): Promise<string | undefined> {
  const cert = await serverCertificate(url);
  const trust = 'Trust for Git';
  const pick = await vscode.window.showWarningMessage(
    `Trust the certificate of ${new URL(url).host} for git in ${basename(folder)}?`,
    {
      modal: true,
      detail: [
        `Subject: ${cert.subject || 'none'}; issued by: ${cert.issuer || 'none'}; valid to ${cert.validTo}.`,
        `SHA-256: ${cert.fingerprint}`,
        "Compare it with the server's Server certificate page. Git in this repository then checks this server's address against it; other remotes and repositories are not changed. When the server gets a new certificate, set up again.",
      ].join('\n\n'),
    },
    trust,
  );
  if (pick !== trust) return CANCELLED;
  await trustForGit(folder, url, cert.pem);
  const token = await secrets.get(tokenKey(url));
  let signIn = '';
  if (token && (await hasCredentialHelper(folder))) {
    const yes = 'Let Git Sign In';
    const also = await vscode.window.showInformationMessage(
      `Let git sign in to ${gitOrigin(url)} with your token too?`,
      {
        modal: true,
        detail:
          "Source Control and git in the terminal then pull and push without asking. Git's credential helper keeps the token (for Windows, the Credential Manager); remove it there to take it back.",
      },
      yes,
    );
    if (also === yes) {
      await storeGitCredential(folder, url, token);
      signIn = ' and signs in with your token';
    }
  }
  // What was set works: git reaches the server's repository without skipping the check.
  const up = await upstreamOf(folder).catch(() => undefined);
  if (token && up && new URL(up.url).host === new URL(url).host)
    await gitReaches(folder, up.url, token);
  void vscode.window.showInformationMessage(
    `Git in ${basename(folder)} trusts ${new URL(url).host}${signIn}.`,
  );
  return undefined;
}
