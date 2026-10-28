// jsdom lacks the layout APIs React Flow uses; minimal stand-ins are enough for structural tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale ? Number(scale) : 1;
  }
}
globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;

// The webview's host bridge; tests read what was posted.
export const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => posted.push(m),
  getState: () => undefined,
  setState: () => {},
});
