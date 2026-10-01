import { expect, test } from 'bun:test';
import { projectSessionsDir } from './session-log';

test('Session Logs live in the project directory under the global config', () => {
  expect(projectSessionsDir({ global: '/h/.config/resector/config.jsonc', project: '' }, '/Users/a/my.app')).toBe('/h/.config/resector/projects/my.app/sessions');
});
