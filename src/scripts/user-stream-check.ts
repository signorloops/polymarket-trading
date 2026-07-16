import { createPolymarketUserWebSocketFromEnv } from '../api/polymarket-user-ws.js';
import { getErrorMessage } from '../utils/errors.js';

async function main(): Promise<void> {
  const client = createPolymarketUserWebSocketFromEnv({ maxReconnectAttempts: 0 });
  try {
    client.connect();
    await client.waitUntilReady();
    console.log(JSON.stringify({ ready: true, authenticatedUserStream: true }, null, 2));
  } finally {
    client.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`Authenticated user stream check failed: ${getErrorMessage(error)}`);
  process.exit(1);
});
