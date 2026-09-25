// Clipboard for copy on select: OSC 52 (through the terminal, also over SSH) plus the platform's copy command,
// since not every terminal honours OSC 52 (e.g. Terminal.app).
import { spawn } from 'node:child_process';

export type Clipboard = (text: string) => Promise<void>;

export function copyCommand(platform: string, env: Record<string, string | undefined>): string[] | null {
  if (platform === 'darwin') return ['pbcopy'];
  if (platform === 'linux') return env.WAYLAND_DISPLAY ? ['wl-copy'] : ['xclip', '-selection', 'clipboard'];
  return null;
}

// osc52: writes the escape sequence through the renderer. A missing or failing command is ignored: OSC 52 may have worked.
export function createClipboard({ osc52, command }: { osc52: (text: string) => void; command: string[] | null }): Clipboard {
  return text => {
    osc52(text);
    if (!command) return Promise.resolve();
    return new Promise(resolve => {
      const child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve());
      child.on('close', () => resolve());
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });
  };
}
