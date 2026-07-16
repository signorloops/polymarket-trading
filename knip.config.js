export default {
  entry: ['src/scripts/*.ts', 'benchmarks/*.ts'],
  project: ['src/**/*.ts'],
  ignoreExportsUsedInFile: true,
  exclude: ['types'],
};
