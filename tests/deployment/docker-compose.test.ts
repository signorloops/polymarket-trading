import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('docker-compose runtime defaults', () => {
  it('sets a default runtime config path for the trading daemon container', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('TRADING_SYSTEM_CONFIG_PATH: /app/config/trading-system.json');
  });

  it('uses a managed volume for state written by the non-root container user', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('state-data:/app/.state');
    expect(compose).not.toContain('./.state:/app/.state');
  });

  it('mounts one bearer-token secret into the daemon and Prometheus', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
    const prometheus = readFileSync(join(process.cwd(), 'monitoring/prometheus.yml'), 'utf8');

    expect(compose).toContain('HTTP_METRICS_TOKEN_FILE: /run/secrets/metrics_token');
    expect(compose).toContain('file: ./.secrets/metrics-token');
    expect(prometheus).toContain('bearer_token_file: /run/secrets/metrics_token');
  });

  it('binds every published administrative port to loopback', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).toContain('"127.0.0.1:9090:9090"');
    expect(compose).toContain('"127.0.0.1:3001:3000"');
    expect(compose).not.toMatch(/^\s+-\s+"?(?:3000|3001|9090):/m);
  });

  it('pins service images and requires a file-backed Grafana password', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).not.toMatch(/^\s+image:\s+[^\n@]+(?::latest)?\s*$/m);
    expect(compose).toContain(
      'GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin_password'
    );
    expect(compose).toContain('GF_AUTH_ANONYMOUS_ENABLED: "false"');
    expect(compose).toContain('file: ./.secrets/grafana-admin-password');
    expect(compose).toContain(
      './monitoring/grafana/provisioning:/etc/grafana/provisioning/dashboards:ro'
    );
    expect(compose).toContain('./monitoring/grafana/dashboards:/etc/grafana/dashboards:ro');
  });

  it('provides opt-in PostgreSQL for transactional order idempotency', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('postgres:17.10-alpine@sha256:');
    expect(compose).toContain('- durable-idempotency');
    expect(compose).toContain('POSTGRES_PASSWORD_FILE: /run/secrets/idempotency_db_password');
    expect(compose).toContain('file: ./.secrets/idempotency-db-password');
    expect(compose).toContain(
      './migrations/001_order_idempotency.sql:/docker-entrypoint-initdb.d/001_order_idempotency.sql:ro'
    );
  });

  it('runs the production daemon with a read-only root and no Linux capabilities', () => {
    const compose = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
    expect(compose).toContain('/tmp:size=64m,mode=1777');
  });
});
