// The engine a flow compiles with (ADR-0003). Option A is the only one today; callers ask here, so
// an Option B runner, or a choice per flow, changes one place (AFD-40).
import type { FlowDocument } from '../flow/types';
import { optionA } from './optionA';
import type { Engine } from './types';

export function engineFor(_doc: FlowDocument): Engine {
  return optionA;
}
