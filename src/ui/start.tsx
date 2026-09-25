// Starts the Gate in the terminal: connect the backend, open a new Session Log, render the screen.
import { homedir } from 'node:os';
import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';
import { connectLlamaCpp } from '../adapters/backend/llamacpp';
import { createSessionLog, projectSessionsDir } from '../adapters/store/session-log';
import { App } from './app';

// Placeholder until Model Profiles and the shipped system prompt exist (#3).
const PROFILE = 'default';
const SYSTEM_PROMPT = "You are a coding agent running locally in the user's project.\n\nBe extremely concise. Sacrifice grammar for the sake of concision.";

export async function start(endpoint: string) {
  const backend = await connectLlamaCpp(endpoint).catch((e: Error) => {
    process.stderr.write(`resector: ${e.message}\n`);
    process.exit(1);
  });
  const log = createSessionLog(projectSessionsDir(homedir(), process.cwd()), `ses_${Date.now().toString(36)}`);
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  const quit = () => {
    renderer.destroy();
    process.exit(0);
  };
  await render(() => <App backend={backend} log={log} profile={PROFILE} systemPrompt={SYSTEM_PROMPT} onQuit={quit} />, renderer);
}
