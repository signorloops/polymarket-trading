import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { waitForDaemonHealth } from '../../src/runtime/daemon-smoke.js';

function listen(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('waitForDaemonHealth', () => {
  it('polls until the daemon health endpoint becomes ready', async () => {
    let isHealthy = false;
    const server = createServer((_request, response) => {
      if (!isHealthy) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false }));
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });

    const address = await listen(server);
    setTimeout(() => {
      isHealthy = true;
    }, 40);

    await expect(
      waitForDaemonHealth(`http://127.0.0.1:${String(address.port)}/health`, {
        timeoutMs: 500,
        pollIntervalMs: 10,
      })
    ).resolves.toEqual({
      healthUrl: `http://127.0.0.1:${String(address.port)}/health`,
      ready: true,
    });

    await close(server);
  });

  it('fails when the daemon never becomes healthy before the timeout', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false }));
    });

    const address = await listen(server);

    await expect(
      waitForDaemonHealth(`http://127.0.0.1:${String(address.port)}/health`, {
        timeoutMs: 60,
        pollIntervalMs: 10,
      })
    ).rejects.toThrow(/did not become healthy/);

    await close(server);
  });
});
