// Session Log files: <data>/resector/sessions/<project-hash>/<id>.jsonl, one event per line.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEvent } from '../../core/log/codec';
import type { SessionLog } from '../../gate/ports';

export function projectSessionsDir(home: string, projectRoot: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(home, '.local/share/resector/sessions', hash);
}

export function createSessionLog(dir: string, id: string): SessionLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  return { path, append: event => appendFileSync(path, encodeEvent(event)) };
}
