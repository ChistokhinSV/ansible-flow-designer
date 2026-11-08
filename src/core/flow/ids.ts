import { isValid, monotonicFactory } from 'ulid';
import type { Ulid } from './types';

export type IdFactory = () => Ulid;

/** Monotonic ULIDs: several IDs created in one command still sort in creation order (D-06). */
export function createIdFactory(): IdFactory {
  const next = monotonicFactory();
  return () => next();
}

export function isUlid(value: string): boolean {
  return isValid(value);
}

export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A ULID as the schema writes it (Crockford base 32, upper case). */
const ULID_TEXT = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A flow's key where it names a file (AFD-133): `<key>.scenarios.yaml`, `generated/<key>.yml`.
 * The key comes from the flow file, and not every path reads it through the schema first, so a
 * key like `../../x` stops here instead of leading a write or a delete out of the folder.
 */
export function flowFileKey(key: unknown): string {
  if (typeof key === 'string' && SLUG.test(key)) return key;
  throw new Error(
    `The flow key ${JSON.stringify(key)} is not a lowercase slug (letters, digits and dashes): fix it in the flow file first`,
  );
}

/** A flow's ID where it names a folder of the extension's storage (runs, scenarios, history). */
export function flowFileId(id: unknown): string {
  if (typeof id === 'string' && ULID_TEXT.test(id)) return id;
  throw new Error(
    `The flow ID ${JSON.stringify(id)} is not a ULID: run Complete IDs on the flow first`,
  );
}

/** Whether a key or ID can name a file (for callers that skip instead of failing). */
export const isFileKey = (key: unknown): key is string => typeof key === 'string' && SLUG.test(key);
export const isFileId = (id: unknown): id is string => typeof id === 'string' && ULID_TEXT.test(id);

/** Human key from a title: lowercase ASCII words joined by dashes. */
export function slugify(title: string, fallback = 'node'): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
