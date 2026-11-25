// Starts Resector in the terminal: config or first-start setup, then the Gate on a new or resumed session.
import { homedir } from 'node:os';
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { copyCommand, createClipboard } from '../adapters/clipboard/clipboard';
import { configPaths } from '../adapters/fs/config';
import { createEditor, createFileEditor } from '../adapters/editor/editor';
import { projectSessionStore } from '../adapters/store/sessions';
import type { SessionRef } from '../core/session/session';
import { Launch } from './launch';
import { terminalSettled } from './settle';

export type Start = { resume?: SessionRef };

export async function start({ resume }: Start) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  // Quitting right after the start (a config error) would leave the terminal's answers on the shell's prompt.
  const exit = async (code: number, message = '') => {
    if (process.stdin.isTTY) await terminalSettled({ write: text => void process.stdout.write(text), prependInputHandler: h => renderer.prependInputHandler(h), removeInputHandler: h => renderer.removeInputHandler(h) });
    renderer.destroy();
    process.stderr.write(message);
    process.exit(code);
  };
  // $EDITOR takes the terminal over while it runs.
  const terminal = { env: process.env, suspend: () => renderer.suspend(), resume: () => renderer.resume() };
  const paths = configPaths({ home: homedir(), cwd: process.cwd(), env: process.env });
  await render(
    () => (
      <Launch
        paths={paths}
        store={projectSessionStore(paths)}
        editor={createEditor(terminal)}
        openFile={createFileEditor(terminal)}
        clipboard={createClipboard({ osc52: text => renderer.copyToClipboardOSC52(text), command: copyCommand(process.platform, process.env) })}
        resume={resume}
        onQuit={() => void exit(0)}
        onTerminate={quit => {
          const signals = ['SIGTERM', 'SIGHUP'] as const;
          signals.forEach(s => process.on(s, quit));
          return () => signals.forEach(s => process.off(s, quit));
        }}
        onFatal={message => void exit(1, `resector: ${message}\n`)}
      />
    ),
    renderer,
  );
}

