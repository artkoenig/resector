// Session Log files: <data>/resector/sessions/<project-hash>/<id>.jsonl, one event per line (architecture §3).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionLog } from '../../core/log/events';

export function projectSessionsDir(home: string, projectRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(home, '.local/share/resector/sessions', hash);
}

export function createSessionLog(dir: string, id: string): SessionLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  return { path, append: event => appendFileSync(path, JSON.stringify(event) + '\n') };
}
