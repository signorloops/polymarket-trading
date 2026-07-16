import { request } from 'node:http';

import { createRuntimeHttpServer } from '../../src/runtime/http-server.js';

function get(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

describe('createRuntimeHttpServer', () => {
  it('serves health, readiness, metrics, and risk endpoints', async () => {
    const server = createRuntimeHttpServer({
      host: '127.0.0.1',
      port: 0,
      riskStatusToken: 'test-risk-token-1234',
      getHealthStatus: () => ({
        ok: true,
        ready: true,
        uptimeSeconds: 12,
        mode: 'paper',
      }),
      getMetrics: () => '# HELP test_metric\n# TYPE test_metric counter\ntest_metric 1\n',
      getRiskStatus: () => ({
        circuitBreakerActive: false,
        metrics: {
          totalExposure: 0,
          dailyPnL: 0,
          unrealizedPnL: 0,
          maxDrawdown: 0,
          positionCount: 0,
        },
      }),
    });

    await server.start();
    const address = server.getAddress();
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    const health = await get(`${baseUrl}/health`);
    const ready = await get(`${baseUrl}/ready`);
    const metrics = await get(`${baseUrl}/metrics`);
    const unauthorizedRisk = await get(`${baseUrl}/api/risk/status`);
    const risk = await get(`${baseUrl}/api/risk/status`, {
      Authorization: 'Bearer test-risk-token-1234',
    });

    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, mode: 'paper' });

    expect(ready.statusCode).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({ ready: true });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('test_metric 1');

    expect(unauthorizedRisk.statusCode).toBe(401);
    expect(risk.statusCode).toBe(200);
    expect(JSON.parse(risk.body)).toMatchObject({
      circuitBreakerActive: false,
    });

    await server.stop();
  });

  it('does not expose the risk endpoint when no access token is configured', async () => {
    const server = createRuntimeHttpServer({
      host: '127.0.0.1',
      port: 0,
      getHealthStatus: () => ({
        ok: true,
        ready: true,
        uptimeSeconds: 1,
        mode: 'paper',
      }),
      getMetrics: () => '',
      getRiskStatus: () => ({
        circuitBreakerActive: false,
        metrics: {
          totalExposure: 100,
          dailyPnL: -10,
          unrealizedPnL: 0,
          maxDrawdown: 10,
          positionCount: 1,
        },
      }),
    });

    await server.start();
    const address = server.getAddress();
    const risk = await get(`http://127.0.0.1:${String(address.port)}/api/risk/status`);

    expect(risk.statusCode).toBe(404);
    expect(risk.body).not.toContain('dailyPnL');
    await server.stop();
  });

  it('protects metrics with bearer authentication when configured', async () => {
    const server = createRuntimeHttpServer({
      host: '127.0.0.1',
      port: 0,
      metricsToken: 'test-metrics-token-123',
      getHealthStatus: () => ({ ok: true, ready: true, uptimeSeconds: 1, mode: 'paper' }),
      getMetrics: () => 'private_metric 7\n',
      getRiskStatus: () => ({
        circuitBreakerActive: false,
        metrics: {
          totalExposure: 0,
          dailyPnL: 0,
          unrealizedPnL: 0,
          maxDrawdown: 0,
          positionCount: 0,
        },
      }),
    });

    await server.start();
    const address = server.getAddress();
    const url = `http://127.0.0.1:${String(address.port)}/metrics`;
    expect((await get(url)).statusCode).toBe(401);
    const authorized = await get(url, { Authorization: 'Bearer test-metrics-token-123' });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.body).toContain('private_metric 7');
    await server.stop();
  });

  it('refuses an unauthenticated non-loopback metrics bind', () => {
    expect(() =>
      createRuntimeHttpServer({
        host: '0.0.0.0',
        port: 0,
        getHealthStatus: () => ({ ok: true, ready: true, uptimeSeconds: 1, mode: 'paper' }),
        getMetrics: () => '',
        getRiskStatus: () => ({
          circuitBreakerActive: false,
          metrics: {
            totalExposure: 0,
            dailyPnL: 0,
            unrealizedPnL: 0,
            maxDrawdown: 0,
            positionCount: 0,
          },
        }),
      })
    ).toThrow(/metrics bearer token is required/);
  });

  it('returns 503 for readiness checks when the system is not ready', async () => {
    const server = createRuntimeHttpServer({
      host: '127.0.0.1',
      port: 0,
      getHealthStatus: () => ({
        ok: true,
        ready: false,
        uptimeSeconds: 1,
        mode: 'paper',
      }),
      getMetrics: () => '',
      getRiskStatus: () => ({
        circuitBreakerActive: false,
        metrics: {
          totalExposure: 0,
          dailyPnL: 0,
          unrealizedPnL: 0,
          maxDrawdown: 0,
          positionCount: 0,
        },
      }),
    });

    await server.start();
    const address = server.getAddress();
    const ready = await get(`http://127.0.0.1:${String(address.port)}/ready`);

    expect(ready.statusCode).toBe(503);
    expect(JSON.parse(ready.body)).toMatchObject({ ready: false });

    await server.stop();
  });
});
