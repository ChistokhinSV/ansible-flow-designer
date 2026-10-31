// A request to a designer panel that the panel answers later by id (AFD-38: one implementation for
// the DOM summary tests read and the PNG drawing exports need, which kept their own waiter maps).

export class RequestTracker<T> {
  private next = 1;
  private readonly waiting = new Map<number, (value: T) => void>();

  /** Sends a request with a fresh id; fails after `timeoutMs` without an answer. */
  request(send: (reqId: number) => void, timeoutMs: number, what: string): Promise<T> {
    const reqId = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        reject(new Error(`${what} timed out`));
      }, timeoutMs);
      this.waiting.set(reqId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      send(reqId);
    });
  }

  /** The panel's answer; an unknown or late id is ignored. */
  answer(reqId: number, value: T): void {
    const resolve = this.waiting.get(reqId);
    this.waiting.delete(reqId);
    resolve?.(value);
  }
}
