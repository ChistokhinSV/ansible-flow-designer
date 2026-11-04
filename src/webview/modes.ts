// The canvas modes and what each is for (AFD-71). AFD-83: the same words show over the canvas in
// Code and Run, where round 1's participant read the switch as stages of designing (P11).
import type { Mode } from './store';

/** AFD-71: each mode says what it is for. */
export const MODES = [
  {
    id: 'design',
    label: 'Design',
    hint: 'Draw the flow: steps, wires, and what happens when a step fails',
  },
  {
    id: 'code',
    label: 'Code',
    hint: 'What each step runs, and where the code differs from the design',
  },
  {
    id: 'run',
    label: 'Run',
    hint: 'The last run on the canvas: how many hosts took each wire, and which steps failed',
  },
] as { id: Mode; label: string; hint: string; soon?: string }[];
