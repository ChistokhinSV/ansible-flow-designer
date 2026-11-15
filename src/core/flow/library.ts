// AFD-295: subflows of an Ansible Flow Server library. A library project's flows offer their
// subflows to every project on the server; a flow takes a copy, pinned to the library flow's
// version and commit (`ref.from: afs://<workspace>/<project>/<file>#<key path>`). The copy lives in
// the flow as any shared subflow (AFD-60); the host lists the library and compares.
import { modelOf } from './model';
import { isLibraryRef } from './refs';
import type { FlowDocument } from './types';
import type { Finding } from './validate';

/** A subflow the server's library offers (GET /api/v1/library/subflows). */
export interface LibrarySubflow {
  /** `afs://<workspace>/<project>/<file>#<key path>`. */
  from: string;
  workspace: string;
  project: string;
  file: string;
  /** Key path of the subflow in its flow. */
  path: string;
  title: string;
  intent?: string;
  /** The library flow's name and version, and the commit read. */
  flow: string;
  version: number;
  commit: string;
}

/** Whether a flow has copies from a library. */
export function usesLibrary(doc: FlowDocument): boolean {
  for (const { node } of modelOf(doc).nodes.values()) if (isLibraryRef(node.ref?.from)) return true;
  return false;
}

/**
 * Problems for the flow's library copies against the library as listed: one it no longer offers,
 * or a newer version of it. Without a listing (no server, not reachable) nothing is said.
 */
export function libraryFindings(
  doc: FlowDocument,
  library: readonly LibrarySubflow[] | undefined,
): Finding[] {
  if (!library) return [];
  const byFrom = new Map(library.map((s) => [s.from, s]));
  const out: Finding[] = [];
  for (const { node, path } of modelOf(doc).nodes.values()) {
    const ref = node.ref;
    if (!ref || !isLibraryRef(ref.from)) continue;
    const label = `"${node.title}"`;
    const offered = byFrom.get(ref.from);
    if (!offered)
      out.push({
        code: 'shared-source',
        severity: 'warning',
        message: `${label} is a copy of ${ref.from}, which the server's library does not offer now (the subflow, its flow or the library is gone, or you may not read it): it runs as it is; Unlink keeps it as this flow's own`,
        path: [...path, 'ref', 'from'],
        node: node.id,
      });
    else if (offered.version > ref.version)
      out.push({
        code: 'shared-source',
        severity: 'info',
        message: `${label}: the library has version ${offered.version} of ${ref.from}, this copy ${ref.version}: Update Shared Subflow copies it again`,
        path: [...path, 'ref', 'version'],
        node: node.id,
      });
  }
  return out;
}
