// The README the VSIX carries (AFD-79), for the extension's page in the Extensions view. That page
// shows only https images and opens no relative link, so the repository README's screenshot was a
// broken image and its guide links went nowhere. This copy drops relative images (the first leaves
// a note on where the guide opens) and turns relative links into their text. `just package` writes
// it to out/vsix/README.md and passes it to vsce with --readme-path.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUIDE_NOTE =
  '> The user guide, with its screenshots, opens inside VS Code: run **Ansible Flow: Open User Guide** from the Command Palette.';

const RELATIVE = /^(?!https?:|mailto:|#|command:)/;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\(([^)\s]+)[^)]*\)\s*$/;
const LINK = /(?<!!)\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g;

export function vsixReadme(text: string): string {
  let noted = false;
  const out: string[] = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) {
      out.push(line);
      continue;
    }
    const image = IMAGE_LINE.exec(line);
    if (image && RELATIVE.test(image[1] ?? '')) {
      if (!noted) out.push(GUIDE_NOTE);
      noted = true;
      continue;
    }
    out.push(
      line.replace(LINK, (all, label: string, target: string) =>
        RELATIVE.test(target) ? label : all,
      ),
    );
  }
  return out.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const target = join(root, 'out', 'vsix', 'README.md');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, vsixReadme(readFileSync(join(root, 'README.md'), 'utf8')));
  console.log(`VSIX README: ${target}`);
}
