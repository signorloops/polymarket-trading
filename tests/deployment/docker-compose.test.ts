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
});
