// Focus requests (AFD-18): F2 Rename, Extract into subflow and Edit reason put the cursor in a
// panel field. The field focuses and selects its text once it is on screen, then the request ends.
// Dialog focus (AFD-47): a dialog takes the focus when it opens, keeps Tab inside, and gives the
// focus back where it was when it closes; menus give it back the same way.
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { type FocusRequest, useUi } from './store';

export function useFocusRequest(
  field: FocusRequest['field'] | undefined,
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
): void {
  const request = useUi((s) => s.focusRequest);
  useEffect(() => {
    const el = ref.current;
    if (!field || request?.field !== field || !el) return;
    el.focus();
    el.select();
    useUi.setState({ focusRequest: null });
  }, [field, request, ref]);
}

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** What Tab can reach inside `box`, in order. */
export function focusables(box: Element | null): HTMLElement[] {
  return [...(box?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
    (el) => !el.closest('[hidden], [inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** What the open menus and dialogs give the focus back to, innermost last. */
const openers: Element[] = [];

/**
 * Where the focus was when this mounted gets it back on unmount, but only while nothing else took
 * it: an item that opened a dialog keeps the focus on the dialog. A dialog opened from a menu item
 * gives it back to what opened the menu, since the item goes with the menu.
 */
export function useReturnFocus(enabled = true): void {
  const [returnTo] = useState(() => {
    if (!enabled) return null;
    const at = document.activeElement;
    return at?.closest?.('[role="menu"]') ? (openers.at(-1) ?? at) : at;
  });
  useEffect(() => {
    if (!returnTo) return;
    openers.push(returnTo);
    return () => {
      openers.splice(openers.lastIndexOf(returnTo), 1);
      const back = returnTo as HTMLElement;
      const idle = document.activeElement === document.body || !document.activeElement;
      if (idle && back.isConnected && typeof back.focus === 'function') back.focus();
    };
  }, [returnTo]);
}

/**
 * A modal dialog's focus: in on open (the dialog's own choice, else its first control), Tab and
 * Shift+Tab wrap inside it, and back where it was on close. Returns the dialog's key handler.
 */
export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
): (e: ReactKeyboardEvent<HTMLElement>) => void {
  useReturnFocus();
  // After the dialog's own effects (a field focused in a timeout), unless one already took it.
  useLayoutEffect(() => {
    const t = setTimeout(() => {
      const box = ref.current;
      if (box && !box.contains(document.activeElement)) focusables(box)[0]?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [ref]);
  return (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables(ref.current);
    const first = list[0];
    const last = list.at(-1);
    if (!first || !last) return;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !ref.current?.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !ref.current?.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  };
}

/**
 * Arrow keys, Home and End on a tab list: the next tab takes the focus and opens (ARIA tabs with
 * automatic activation). Put on the element with `role="tablist"`.
 */
export function onTabListKeys(e: ReactKeyboardEvent<HTMLElement>): void {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const next =
    e.key === 'ArrowRight'
      ? (at + 1) % tabs.length
      : e.key === 'ArrowLeft'
        ? (at - 1 + tabs.length) % tabs.length
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? tabs.length - 1
            : -1;
  if (next < 0) return;
  e.preventDefault();
  e.stopPropagation();
  tabs[next]?.focus();
  tabs[next]?.click();
}
