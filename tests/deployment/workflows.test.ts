import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('GitHub workflow runtime config validation', () => {
  it('runs runtime config validation in CI', () => {
    const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

    expect(ciWorkflow).toContain(
      'npm run runtime-config:validate -- ./config/trading-system.example.json'
    );
  });

  it('runs daemon smoke startup verification in CI', () => {
    const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

    expect(ciWorkflow).toContain('npm run smoke:daemon:built');
    expect(ciWorkflow).toContain('npm run smoke:docker:built');
  });

  it('runs runtime config validation before release', () => {
    const releaseWorkflow = readFileSync(
      join(process.cwd(), '.github/workflows/release.yml'),
      'utf8'
    );

    expect(releaseWorkflow).toContain(
      'npm run runtime-config:validate -- ./config/trading-system.example.json'
    );
  });

  it('runs daemon smoke startup verification before release publishing', () => {
    const releaseWorkflow = readFileSync(
      join(process.cwd(), '.github/workflows/release.yml'),
      'utf8'
    );

    expect(releaseWorkflow).toContain('npm run smoke:daemon:built');
    expect(releaseWorkflow).toContain('npm run smoke:docker:built');
  });
});
