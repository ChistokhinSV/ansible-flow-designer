// AFD-81: events.jsonl read while the run writes it. Polling, not fs.watch: change events do not
// reach a file on a Docker bind mount or under /mnt in WSL reliably on Windows.
import { open, stat } from 'node:fs/promises';
import { splitLines } from '../../core/run/events';

export interface Tail {
  /** One last read; a final line without a line break counts too. */
  stop(): Promise<void>;
}

export function tailFile(path: string, onLines: (lines: string[]) => void, intervalMs = 250): Tail {
  let offset = 0;
  let carry = '';
  // A UTF-8 character cut between two reads waits for its other bytes.
  let decoder = new TextDecoder();
  let busy: Promise<void> = Promise.resolve();
  const read = async () => {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return; // not written yet
    }
    if (size < offset) {
      // Written again from the start.
      offset = 0;
      carry = '';
      decoder = new TextDecoder();
    }
    if (size === offset) return;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      offset += bytesRead;
      const r = splitLines(carry, decoder.decode(buf.subarray(0, bytesRead), { stream: true }));
      carry = r.carry;
      if (r.lines.length > 0) onLines(r.lines);
    } finally {
      await fh.close();
    }
  };
  const tick = () => {
    busy = busy.then(read).catch(() => undefined);
    return busy;
  };
  const timer = setInterval(tick, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await tick();
      if (carry.trim()) onLines([carry]);
      carry = '';
    },
  };
}
