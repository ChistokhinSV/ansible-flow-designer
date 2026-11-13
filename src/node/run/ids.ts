/** A run id: the start time, sortable (run folders are pruned by it, AFD-29). */
export function stamp(d = new Date()): string {
  return d
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}
