// Starts Resector in the terminal: config or first-start setup, then the Gate on a new Session Log.
import { homedir } from 'node:os';
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { configPaths } from '../adapters/fs/config';
import { createSessionLog, projectSessionsDir } from '../adapters/store/session-log';
import { Launch } from './launch';

export async function start() {
  const home = homedir();
  const cwd = process.cwd();
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const exit = (code: number, message = '') => {
    renderer.destroy();
    process.stderr.write(message);
    process.exit(code);
  };
  await render(
    () => (
      <Launch
        paths={configPaths({ home, cwd, env: process.env })}
        openLog={() => createSessionLog(projectSessionsDir(home, cwd), `ses_${Date.now().toString(36)}`)}
        onQuit={() => exit(0)}
        onFatal={message => exit(1, `resector: ${message}\n`)}
      />
    ),
    renderer,
  );
}
