// Starts Resector in the terminal: config or first-start setup, then the Gate on a new or resumed session.
import { homedir } from 'node:os';
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { configPaths } from '../adapters/fs/config';
import { projectSessionsDir } from '../adapters/store/session-log';
import { openSessionStore } from '../adapters/store/sessions';
import type { Start } from '../main';
import { Launch } from './launch';

const projectStore = () => openSessionStore(projectSessionsDir(homedir(), process.cwd()));

export async function start({ resume }: Start) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const exit = (code: number, message = '') => {
    renderer.destroy();
    process.stderr.write(message);
    process.exit(code);
  };
  await render(
    () => (
      <Launch
        paths={configPaths({ home: homedir(), cwd: process.cwd(), env: process.env })}
        store={projectStore()}
        resume={resume}
        onQuit={() => exit(0)}
        onFatal={message => exit(1, `resector: ${message}\n`)}
      />
    ),
    renderer,
  );
}

// --export-fixture [id]: the Session Log as JSONL on stdout, for golden tests (architecture §7).
export function exportFixture(which: true | string) {
  try {
    process.stdout.write(projectStore().exportLog(which));
  } catch (e) {
    process.stderr.write(`resector: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
