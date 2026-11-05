// The test sets the kit can run: variants A and B are rounds 1 and 2 (wave 8), C is round 3.
import { roundThreeStudy } from './round3';
import type { Study } from './study';
import { wave8Study } from './wave8';

export const VARIANT_NAMES = ['a', 'b', 'c'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

export function studyOf(variant: string): Study {
  if (variant === 'a' || variant === 'b') return wave8Study(variant);
  if (variant === 'c') return roundThreeStudy();
  throw new Error(`variant must be one of ${VARIANT_NAMES.join(', ')}`);
}
