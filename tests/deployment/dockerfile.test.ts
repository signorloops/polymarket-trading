import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Dockerfile production install', () => {
  it('pins both Node base stages to an immutable image digest', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    const fromLines = dockerfile.match(/^FROM .+$/gm) ?? [];

    expect(fromLines).toHaveLength(2);
    expect(fromLines.every((line) => /node:20-alpine@sha256:[a-f0-9]{64}/.test(line))).toBe(true);

    const developmentDockerfile = readFileSync(join(process.cwd(), 'Dockerfile.dev'), 'utf8');
    expect(developmentDockerfile).toMatch(/^FROM node:20-alpine@sha256:[a-f0-9]{64}$/m);
    expect(developmentDockerfile).toContain('npm ci --ignore-scripts');
  });

  it('skips lifecycle scripts in both build and production dependency installs', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
  });

  it('prepares a non-root-writable state directory', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('mkdir -p /app/.state');
    expect(dockerfile).toContain('adduser -S nodejs -u 1001 -G nodejs');
    expect(dockerfile).toContain('chown -R nodejs:nodejs /app/.state');
    expect(dockerfile).toContain('USER nodejs');
  });
});
