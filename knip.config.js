export default {
  entry: ['src/index.ts', 'benchmarks/*.ts'],
  project: ['src/**/*.ts'],
  ignoreBinaries: ['knip'],
  exclude: ['types'],
};
