// Runner port (adapters/bash, adapters/search): runs a command, streaming its output; aborting the signal kills it.
import type { Stopped } from '../log/events';

// exit: null when the run was stopped.
export type RunResult = { output: string; exit: number | null; stopped: Stopped | null };

// timeout: seconds after which a run is stopped.
export type RunOptions = { signal: AbortSignal; onOutput: (text: string) => void };
export type Runner = { timeout: number; run(command: string, options: RunOptions): Promise<RunResult> };
