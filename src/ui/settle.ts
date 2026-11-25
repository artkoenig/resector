// Waits until the terminal has answered the renderer's startup queries, so that quitting early leaves none on the shell.

// What it uses of the renderer and the terminal.
export type Settling = {
  write: (text: string) => void;
  prependInputHandler: (handler: (sequence: string) => boolean) => void;
  removeInputHandler: (handler: (sequence: string) => boolean) => void;
};

// Device status report: every terminal answers it.
const STATUS_QUERY = '\x1b[5n';
const STATUS_REPLY = /\x1b\[0n/;
// A terminal that does not answer is not waited for longer (ms).
const TIMEOUT = 1000;

// A terminal answers in order: once the status asked now is reported, the answers to everything asked before have
// been read.
export function terminalSettled(terminal: Settling, timeout = TIMEOUT): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      terminal.removeInputHandler(handler);
      resolve();
    };
    const handler = (sequence: string) => {
      if (!STATUS_REPLY.test(sequence)) return false;
      done();
      return true;
    };
    const timer = setTimeout(done, timeout);
    terminal.prependInputHandler(handler);
    terminal.write(STATUS_QUERY);
  });
}
