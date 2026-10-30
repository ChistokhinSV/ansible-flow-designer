// Focus requests (AFD-18): F2 Rename, Extract into subflow and Edit reason put the cursor in a
// panel field. The field focuses and selects its text once it is on screen, then the request ends.
import { type RefObject, useEffect } from 'react';
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
