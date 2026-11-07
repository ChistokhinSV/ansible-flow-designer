// The README the VSIX carries (AFD-79), for the extension's page in the Extensions view and the
// Marketplace. That page shows only https images and opens no relative link. AFD-79 dropped the
// relative images and unlinked the relative links, as the repository was not public. AFD-113: it is
// (github.com/ChistokhinSV/ansible-flow-designer), so relative images point at its raw files and
// relative links at its pages, and the page shows the screenshots. `just package` writes it to
// out/vsix/README.md and passes it to vsce with --readme-path.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'https://github.com/ChistokhinSV/ansible-flow-designer';
const RAW = 'https://raw.githubusercontent.com/ChistokhinSV/ansible-flow-designer/main';

export const GUIDE_NOTE =
  '> The user guide also opens inside VS Code: run **Ansible Flow: Open User Guide** from the Command Palette.';

const RELATIVE = /^(?!https?:|mailto:|#|command:)/;
/** A Markdown image or link: `![alt](target)` or `[label](target)`. */
const MARKDOWN = /(!?)\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g;
/** An HTML image: `<img src="target" …>`. */
const HTML_IMAGE = /(<img\b[^>]*\bsrc=")([^"]+)(")/g;

/** A repository path as an absolute URL: images from raw files, pages from the blob view. */
function absolute(target: string, image: boolean): string {
  const [path = '', anchor] = target.split('#');
  const clean = posix.normalize(path).replace(/^\.\//, '');
  if (image) return `${RAW}/${clean}`;
  const page = clean.endsWith('/') || !posix.extname(clean) ? 'tree' : 'blob';
  return `${REPO}/${page}/main/${clean}${anchor ? `#${anchor}` : ''}`;
}

export function vsixReadme(text: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) {
      out.push(line);
      continue;
    }
    out.push(
      line
        .replace(MARKDOWN, (all, bang: string, label: string, target: string, rest: string) =>
          RELATIVE.test(target)
            ? `${bang}[${label}](${absolute(target, bang === '!')}${rest})`
            : all,
        )
        .replace(HTML_IMAGE, (all, start: string, src: string, end: string) =>
          RELATIVE.test(src) ? `${start}${absolute(src, true)}${end}` : all,
        ),
    );
  }
  // The guide is in VS Code too, where its pages open beside the flow.
  while (out.at(-1) === '') out.pop();
  out.push('', GUIDE_NOTE, '');
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const target = join(root, 'out', 'vsix', 'README.md');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, vsixReadme(readFileSync(join(root, 'README.md'), 'utf8')));
  console.log(`VSIX README: ${target}`);
}
