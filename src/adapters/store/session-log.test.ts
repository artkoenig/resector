import { expect, test } from 'bun:test';
import { configPaths, projectKey } from '../fs/config';
import { projectSessionsDir } from './session-log';

test('Session Logs live in the data root of the Project Home', () => {
  const paths = configPaths({ home: '/h', cwd: '/p', env: { XDG_DATA_HOME: '/d' } });
  expect(projectSessionsDir(paths)).toBe(`/d/resector/projects/${projectKey('/p')}/sessions`);
});
