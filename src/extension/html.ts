import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Webview page with a strict CSP: nonce scripts, styles and fonts from the bundle only (ADR-0001). */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(18).toString('base64');
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('index.css')}">
<title>Ansible Flow Designer</title>
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset('index.js')}"></script>
</body>
</html>`;
}
