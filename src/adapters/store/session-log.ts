// Session Log files: <config>/projects/<name>/sessions/<id>.jsonl, one event per line.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { encodeEvent } from '../../core/log/codec';
import type { SessionLog } from '../../gate/ports';
import type { ConfigPaths } from '../fs/config';
import { personalInstructionsDir } from '../fs/project';

// Next to the project's personal instructions, under the global config directory.
export const projectSessionsDir = (paths: ConfigPaths, projectRoot: string) => join(personalInstructionsDir(paths, projectRoot), 'sessions');

export function createSessionLog(dir: string, id: string): SessionLog & { path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);
  return { path, append: event => appendFileSync(path, encodeEvent(event)) };
}
