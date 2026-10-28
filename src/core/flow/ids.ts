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
