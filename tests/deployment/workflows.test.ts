import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_DIRECTORY = join(process.cwd(), '.github/workflows');

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIRECTORY)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .sort();
}

describe('GitHub workflow runtime config validation', () => {
  it('pins every third-party action to an immutable commit', () => {
    for (const file of workflowFiles()) {
      const workflow = readFileSync(join(WORKFLOW_DIRECTORY, file), 'utf8');
      const uses = [...workflow.matchAll(/uses:\s+[^\s@]+@([^\s#]+)/g)].map((match) => match[1]);

      expect(uses.length).toBeGreaterThan(0);
      expect(uses.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true);
    }
  });

  it('uses the supported combined JavaScript and TypeScript CodeQL language', () => {
    const securityWorkflow = readFileSync(
      join(process.cwd(), '.github/workflows/security.yml'),
      'utf8'
    );

    expect(securityWorkflow).toContain('languages: javascript-typescript');
    expect(securityWorkflow).not.toContain("language: ['javascript', 'typescript']");
  });

  it('does not execute dependency lifecycle scripts in automation installs', () => {
    for (const file of workflowFiles()) {
      const workflow = readFileSync(join(WORKFLOW_DIRECTORY, file), 'utf8');
      expect(workflow).not.toMatch(/run:\s+npm ci\s*$/m);
    }
  });

  it('does not auto-merge dependency updates from a write-capable workflow', () => {
    for (const file of workflowFiles()) {
      const workflow = readFileSync(join(WORKFLOW_DIRECTORY, file), 'utf8');
      expect(workflow).not.toMatch(/gh pr merge/);
    }
  });

  it('runs CI and code-quality checks for pull requests', () => {
    for (const file of ['ci.yml', 'code-quality.yml']) {
      const workflow = readFileSync(join(WORKFLOW_DIRECTORY, file), 'utf8');
      expect(workflow).toMatch(
        /on:\n[\s\S]*? {2}pull_request:\n {4}branches: \[main, develop\]\n\npermissions:/
      );
      expect(workflow).not.toMatch(/permissions:\n[\s\S]*? {2}pull_request:/);
    }
  });

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
