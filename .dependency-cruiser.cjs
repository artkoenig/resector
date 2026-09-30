// Module boundaries (architecture §2): Core is pure; UI depends on Core, never the reverse.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-not-to-outer-layers',
      comment: 'Core has no I/O and never imports the Gate, UI or adapters; adapters are injected.',
      severity: 'error',
      from: { path: '^src/core' },
      to: { path: '^src/(ui|gate|adapters)' },
    },
    // Layers of docs/strategic-design.md: ui → gate → core, adapters → core. Exceptions list the known violations;
    // they only shrink.
    {
      name: 'adapters-not-to-ui-or-gate',
      comment: 'Adapters implement the Gate ports of gate/ports.ts; nothing else of the Gate or UI.',
      severity: 'error',
      from: { path: '^src/adapters' },
      to: { path: '^src/(ui|gate)', pathNot: '^src/gate/ports\\.ts$' },
    },
    {
      name: 'gate-not-to-adapters',
      comment: 'The Review Gate declares its ports; the composition root wires adapters in.',
      severity: 'error',
      from: { path: '^src/gate' },
      to: { path: '^src/adapters' },
    },
    {
      name: 'gate-not-to-ui',
      comment: 'The Review Gate is the application layer below the views.',
      severity: 'error',
      from: { path: '^src/gate' },
      to: { path: '^src/ui' },
    },
    {
      name: 'ui-not-to-adapters',
      comment: 'Views get adapters through the Gate; only the composition root (launch, start) imports them.',
      severity: 'error',
      from: { path: '^src/ui/', pathNot: '^src/ui/(launch\\.tsx$|start\\.tsx$|setup\\.tsx$|sessions\\.tsx$)' },
      to: { path: '^src/adapters' },
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
    // Type-only imports count: a port belongs to the layer that uses it.
    tsPreCompilationDeps: true,
    exclude: { path: '\\.(test|harness)\\.tsx?$' },
  },
};
