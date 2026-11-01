// What is open over the canvas, as one declared policy (AFD-35) instead of resets spread over the
// store's setters and the keyboard handler. Overlays stack on purpose in places (a reason dialog
// over the Details panel, the pick bar while the canvas stays usable), so the store keeps one
// field per overlay and this table says which ones each opening closes.

export type Overlay =
  | 'quickAdd'
  | 'portMenu'
  | 'contextMenu'
  | 'pick'
  | 'decide'
  | 'ignore'
  | 'accept'
  | 'cheatSheet'
  | 'preview';

/** The closed value of each overlay field. */
export const CLOSED = {
  quickAdd: null,
  portMenu: null,
  contextMenu: null,
  pick: null,
  decide: null,
  ignore: null,
  accept: null,
  cheatSheet: false,
  preview: null,
} as const satisfies Record<Overlay, null | false>;

/** Opening (or changing) one of these closes the overlays listed. */
export const CLOSES: Record<Overlay | 'level' | 'mode' | 'details', readonly Overlay[]> = {
  quickAdd: [],
  portMenu: ['contextMenu'],
  contextMenu: ['portMenu', 'preview'],
  pick: ['portMenu'],
  decide: ['portMenu'],
  ignore: [],
  accept: [],
  cheatSheet: ['contextMenu'],
  preview: [],
  /** A node's Details opened from a menu, a lens fix or a drift action (AFD-43). */
  details: ['preview', 'portMenu', 'contextMenu', 'quickAdd'],
  /** Another level: what was open belongs to the level being left. */
  level: ['portMenu', 'contextMenu', 'pick', 'quickAdd', 'decide', 'preview'],
  mode: ['portMenu', 'contextMenu', 'pick', 'quickAdd', 'preview'],
};

/** Overlays that own the pointer: no hover card opens over them. */
export const HOLDS_POINTER: readonly Overlay[] = [
  'portMenu',
  'contextMenu',
  'pick',
  'quickAdd',
  'decide',
];

/**
 * What Escape closes, innermost first; after them it clears the selection, which asks first while a
 * binding is staged (AFD-30, AFD-43).
 */
export const ESCAPE_ORDER: readonly Overlay[] = [
  'contextMenu',
  'portMenu',
  'cheatSheet',
  'quickAdd',
  'decide',
  'ignore',
  'accept',
  'pick',
];

/** The state change that closes what `what` closes. */
export function closing(what: keyof typeof CLOSES): Partial<typeof CLOSED> {
  return Object.fromEntries(CLOSES[what].map((o) => [o, CLOSED[o]]));
}

/** Whether an overlay is open in this state. */
export function isOpen(state: Record<Overlay, unknown>, overlay: Overlay): boolean {
  return !!state[overlay];
}
