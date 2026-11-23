// Step-by-step runs (AFD-346, ADR-0039): the driver's side of the file channel on this machine.
// A local, WSL or container run shares its run folder with this machine; an SSH run gets the same
// file with putRunFile (src/node/ssh/remote.ts), its events come back as they always do.
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STEP_CONTROL, type StepControl } from '../../core/run/step';

/** Windows refuses to replace a file another process has open (the run reading it): try again. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TRIES = 40;
const WAIT_MS = 25;

/** Replaces the run's control.json whole: the run never reads half a file. */
export async function writeControl(runDir: string, control: StepControl): Promise<void> {
  await writeWhole(join(runDir, STEP_CONTROL), JSON.stringify(control));
}

let serial = 0;

/** Writes a file whole (a temporary file, then a rename): a reader never sees half of it. */
export async function writeWhole(path: string, text: string): Promise<void> {
  serial += 1;
  const tmp = `${path}.${process.pid}.${serial}.tmp`;
  await writeFile(tmp, text, 'utf8');
  for (let i = 1; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e) {
      if (i >= TRIES || !BUSY.has((e as NodeJS.ErrnoException).code ?? '')) {
        await unlink(tmp).catch(() => undefined);
        throw e;
      }
      await new Promise((r) => setTimeout(r, WAIT_MS));
    }
  }
}
