// Mutation gate: 100 % on Core (NFR-4). NoCoverage counts as survived.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'bun',
  plugins: ['@hughescr/stryker-bun-runner'],
  coverageAnalysis: 'perTest',
  mutate: ['src/core/**/*.ts', '!src/core/**/*.test.ts'],
  checkers: [],
  reporters: ['clear-text', 'progress', 'html'],
  thresholds: { high: 100, low: 100, break: 100 },
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
};
