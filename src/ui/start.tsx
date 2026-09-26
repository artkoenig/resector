// Starts Resector in the terminal: config or first-start setup, then the Gate on a new or resumed session.
import { homedir } from 'node:os';
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { copyCommand, createClipboard } from '../adapters/clipboard/clipboard';
import { configPaths } from '../adapters/fs/config';
import { createEditor, createFileEditor } from '../adapters/editor/editor';
import { projectSessionStore } from '../adapters/store/sessions';
import type { Start } from '../main';
import { Launch } from './launch';

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
        store={projectSessionStore(homedir(), process.cwd())}
        editor={createEditor({ env: process.env, suspend: () => renderer.suspend(), resume: () => renderer.resume() })}
        openFile={createFileEditor({ env: process.env, suspend: () => renderer.suspend(), resume: () => renderer.resume() })}
        clipboard={createClipboard({ osc52: text => renderer.copyToClipboardOSC52(text), command: copyCommand(process.platform, process.env) })}
        resume={resume}
        onQuit={() => exit(0)}
        onFatal={message => exit(1, `resector: ${message}\n`)}
      />
    ),
    renderer,
  );
}

