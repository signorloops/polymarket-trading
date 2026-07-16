import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Dockerfile production install', () => {
  it('skips lifecycle scripts in both build and production dependency installs', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
  });

  it('prepares a non-root-writable state directory', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('mkdir -p /app/.state');
    expect(dockerfile).toContain('chown -R nodejs:nodejs /app/.state');
  });
});
