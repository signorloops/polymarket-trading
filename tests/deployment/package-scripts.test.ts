import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package daemon smoke scripts', () => {
  it('provides both convenience and built-artifact smoke commands', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:daemon']).toBe(
      'npm run build && npm run smoke:daemon:built'
    );
    expect(packageJson.scripts?.['smoke:daemon:built']).toBe(
      'node dist/src/scripts/daemon-smoke.js'
    );
    expect(packageJson.scripts?.['smoke:docker']).toBe(
      'npm run build && npm run smoke:docker:built'
    );
    expect(packageJson.scripts?.['smoke:docker:built']).toBe(
      'node dist/src/scripts/docker-smoke.js'
    );
  });

  it('cleans stale output before building and publishes only explicit artifacts', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      files?: string[];
      types?: string;
      exports?: unknown;
    };

    expect(packageJson.scripts?.build).toBe('npm run clean && tsc');
    expect(packageJson.scripts?.prepack).toBe('npm run build');
    expect(packageJson.files).toEqual([
      'dist/src',
      'dist/benchmarks',
      'README.md',
      'README.en.md',
      'README.zh-CN.md',
    ]);
    expect(packageJson.types).toBe('dist/src/index.d.ts');
    expect(packageJson.exports).toBeDefined();
  });
});
