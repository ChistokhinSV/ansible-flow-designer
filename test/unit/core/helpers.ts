import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXAMPLES_DIR = join(__dirname, '../../../examples');
export const FIXTURES_DIR = join(__dirname, '../../fixtures/flows');

export function exampleFlows(): { name: string; text: string }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.flow.yaml'))
    .map((name) => ({ name, text: readFileSync(join(EXAMPLES_DIR, name), 'utf8') }));
}

export function readExample(name: string): string {
  return readFileSync(join(EXAMPLES_DIR, name), 'utf8');
}

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}
