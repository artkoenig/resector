// Module boundaries (architecture §2): Core is pure; UI depends on Core, never the reverse.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-not-to-ui-or-adapters',
      comment: 'Core has no I/O and never imports UI or adapters; adapters are injected.',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^src/(ui|adapters)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '\\.test\\.ts$' },
  },
};
