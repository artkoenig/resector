// Session Log JSONL codec: one event per line.
import type { SessionEvent } from './events';

export const encodeEvent = (event: SessionEvent): string => JSON.stringify(event) + '\n';

export const decodeLog = (text: string): SessionEvent[] =>
  text
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
