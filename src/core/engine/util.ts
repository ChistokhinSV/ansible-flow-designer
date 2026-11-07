// Small helpers shared by the engines: a content checksum and duration parsing.

/** cyrb53: a fast 53-bit string hash (not cryptographic); detects hand edits of generated files. */
export function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// AFD-103: the parser lives in core/flow, so the validator can check a timeout too. AFD-111: the
// formatter too, so the Execution tab can show a delay the way Timeout is written.
export { duration, durationSeconds } from '../flow/duration';

import { durationSeconds } from '../flow/duration';
import { templated } from '../flow/jinja';

/**
 * A step's timeout as the task's `timeout:` (AFD-112): whole seconds for a duration, a template
 * given at run time as it is (Ansible renders it to seconds before the task runs), else nothing.
 */
export function timeoutValue(text: string | number | undefined): number | string | undefined {
  return templated(text) ? text.trim() : durationSeconds(text);
}
