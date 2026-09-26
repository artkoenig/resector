// $EDITOR (FR-8): the text in a temporary file, the editor on the terminal, the saved text back.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Editor } from '../../core/context/operations';

// suspend/resume: hand the terminal to the editor and take it back. dir: where the temporary file goes.
export type EditorOptions = { env: Record<string, string | undefined>; suspend: () => void; resume: () => void; dir?: string };

export function createEditor({ env, suspend, resume, dir = tmpdir() }: EditorOptions): Editor {
  const open = createFileEditor({ env, suspend, resume });
  return async text => {
    const folder = mkdtempSync(join(dir, 'resector-'));
    const file = join(folder, 'block.txt');
    try {
      writeFileSync(file, text);
      await open(file);
      return readFileSync(file, 'utf8');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };
}

// The editor on a file itself (`e` on an @file reference, FR-27).
export function createFileEditor({ env, suspend, resume }: Omit<EditorOptions, 'dir'>): (file: string) => Promise<void> {
  // $VISUAL, then $EDITOR, as a shell command line (e.g. `code --wait`).
  const command = env.VISUAL || env.EDITOR || 'vi';
  return async file => {
    suspend();
    let status: number | null;
    try {
      status = spawnSync('sh', ['-c', `${command} "$1"`, 'sh', file], { stdio: 'inherit' }).status;
    } finally {
      resume();
    }
    if (status !== 0) throw new Error(`${command} exited with ${status}`);
  };
}
