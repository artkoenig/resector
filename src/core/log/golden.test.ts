// Golden tests (architecture §7): Session Log fixtures (`resector --export-fixture`) → Context + request payload.
import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderNative } from '../render/native';
import { summarize } from '../session/session';
import { decodeLog } from './codec';
import { fold } from './fold';

const FIXTURES = join(import.meta.dir, '../../../test/fixtures');

for (const file of readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl'))) {
  test(`fixture ${file} replays to its Context and request`, () => {
    const events = decodeLog(readFileSync(join(FIXTURES, file), 'utf8'));
    const context = fold(events);
    expect({ summary: summarize(events), context, request: renderNative(context) }).toMatchSnapshot();
  });
}
