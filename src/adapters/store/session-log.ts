// Session Log files: <data root of the Project Home>/sessions/<id>.jsonl, one event per line.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEvent } from '../../core/log/codec';
import type { SessionLog } from '../../gate/ports';
import type { ConfigPaths } from '../fs/config';

export const projectSessionsDir = (paths: ConfigPaths) => join(paths.projectHome.data, 'sessions');

export function createSessionLog(dir: string, id: string): SessionLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  return { path, append: event => appendFileSync(path, encodeEvent(event)) };
}
