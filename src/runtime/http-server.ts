import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';

export interface HealthStatus {
  ok: boolean;
  ready: boolean;
  uptimeSeconds: number;
  mode: 'paper' | 'live';
  running?: boolean;
  websocketConnected?: boolean;
  configuredMarkets?: number;
  configuredEvents?: number;
  circuitBreakerActive?: boolean;
}

export interface RiskStatusPayload {
  circuitBreakerActive: boolean;
  metrics: {
    totalExposure: number;
    dailyPnL: number;
    unrealizedPnL: number;
    maxDrawdown: number;
    positionCount: number;
  };
}

export interface RuntimeHttpServerOptions {
  host: string;
  port: number;
  riskStatusToken?: string;
  metricsToken?: string;
  getHealthStatus(): HealthStatus;
  getMetrics(): string;
  getRiskStatus(): RiskStatusPayload;
}

export interface RuntimeHttpServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getAddress(): AddressInfo;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
}

function hasValidBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const authorization = req.headers.authorization ?? '';
  const expected = `Bearer ${expectedToken}`;
  const actualDigest = createHash('sha256').update(authorization).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export function createRuntimeHttpServer(options: RuntimeHttpServerOptions): RuntimeHttpServer {
  assertStrongToken(options.metricsToken, 'metrics');
  assertStrongToken(options.riskStatusToken, 'risk status');
  if (!isLoopbackHost(options.host) && !options.metricsToken) {
    throw new Error('A metrics bearer token is required when HTTP binds outside loopback');
  }
  let server: Server | null = null;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      writeJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    let path: string;
    try {
      path = requestPath(req);
    } catch {
      writeJson(res, 400, { error: 'Invalid request path' });
      return;
    }

    try {
      if (path === '/health') {
        const health = options.getHealthStatus();
        writeJson(res, health.ok ? 200 : 503, health);
        return;
      }

      if (path === '/ready') {
        const health = options.getHealthStatus();
        writeJson(res, health.ready ? 200 : 503, health);
        return;
      }

      if (path === '/metrics') {
        if (options.metricsToken && !hasValidBearerToken(req, options.metricsToken)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          writeJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(options.getMetrics());
        return;
      }

      if (path === '/api/risk/status') {
        if (!options.riskStatusToken) {
          writeJson(res, 404, { error: 'Not found' });
          return;
        }
        if (!hasValidBearerToken(req, options.riskStatusToken)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          writeJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        writeJson(res, 200, options.getRiskStatus());
        return;
      }

      writeJson(res, 404, { error: 'Not found' });
    } catch {
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'Internal server error' });
      } else {
        res.destroy();
      }
    }
  };

  return {
    async start(): Promise<void> {
      if (server) {
        return;
      }

      server = createServer(handler);
      server.headersTimeout = 10_000;
      server.requestTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 50;
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(options.port, options.host, () => {
          server?.off('error', reject);
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      const activeServer = server;
      server = null;
      await new Promise<void>((resolve, reject) => {
        const forceClose = setTimeout(() => {
          activeServer.closeAllConnections();
        }, 5_000);
        forceClose.unref();
        activeServer.close((error) => {
          clearTimeout(forceClose);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },

    getAddress(): AddressInfo {
      if (!server) {
        throw new Error('HTTP server is not running');
      }

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('HTTP server address is unavailable');
      }

      return address;
    },
  };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

function assertStrongToken(token: string | undefined, endpoint: string): void {
  if (token !== undefined && token.length < 16) {
    throw new Error(`The ${endpoint} bearer token must contain at least 16 characters`);
  }
}
