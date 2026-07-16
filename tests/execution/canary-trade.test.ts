import { jest } from '@jest/globals';
import {
  CANARY_CONFIRMATION_PHRASE,
  CANARY_HARD_MAX_NOTIONAL_USD,
  DEFAULT_CANARY_POLL_INTERVAL_MS,
  DEFAULT_CANARY_POLL_TIMEOUT_MS,
  parseCanaryTradeConfigFromEnv,
  runCanaryTrade,
  type CanaryTradePersistencePort,
  type CanaryTradeConfig,
} from '../../src/execution/canary-trade.js';
import type { CanaryKillSwitchStatePort } from '../../src/execution/canary-kill-switch.js';
import type { TradingClient } from '../../src/api/trading-client.js';

describe('canary trade', () => {
  function createConfig(overrides: Partial<CanaryTradeConfig> = {}): CanaryTradeConfig {
    return {
      tokenId: '1234567890',
      side: 'buy',
      size: 2,
      price: 0.4,
      maxNotionalUsd: 1,
      dryRun: true,
      tradingEnabled: false,
      confirmation: '',
      pollIntervalMs: DEFAULT_CANARY_POLL_INTERVAL_MS,
      pollTimeoutMs: DEFAULT_CANARY_POLL_TIMEOUT_MS,
      stateFilePath: '',
      ...overrides,
    };
  }

  function createClient(): TradingClient {
    return makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
  }

  function makeSafeClient<T extends TradingClient>(
    client: T
  ): T & {
    getOrder: jest.Mock;
    getBalances: jest.Mock;
    getCollateralBalance: jest.Mock;
    getOpenOrders: jest.Mock;
    startHeartbeat: jest.Mock;
    stopHeartbeat: jest.Mock;
  } {
    return {
      ...client,
      getOrder:
        'getOrder' in client
          ? (client.getOrder as jest.Mock)
          : jest.fn().mockResolvedValue({
              id: '0xorder',
              marketId: '1234567890',
              side: 'buy',
              size: 2,
              price: 0.4,
              status: 'cancelled',
              filledSize: 0,
              remainingSize: 2,
              createdAt: '2026-04-23T00:00:00.000Z',
              updatedAt: '2026-04-23T00:00:01.000Z',
            }),
      getBalances: jest
        .fn()
        .mockResolvedValue([{ assetId: '1234567890', size: 100, allowances: { exchange: 100 } }]),
      getCollateralBalance: jest.fn().mockResolvedValue({
        size: 100,
        allowances: { exchange: 100 },
      }),
      getOpenOrders: jest.fn().mockResolvedValue([]),
      startHeartbeat: jest.fn().mockResolvedValue(undefined),
      stopHeartbeat: jest.fn(),
    };
  }

  function createPersistence(): CanaryTradePersistencePort {
    return {
      saveRecord: jest.fn(),
    };
  }

  function createKillSwitch(state: {
    active: boolean;
    updatedAt: number;
    reason?: string;
  }): CanaryKillSwitchStatePort {
    return {
      loadState: jest.fn().mockReturnValue(state),
      saveState: jest.fn(),
    };
  }

  function createInactiveKillSwitch(): CanaryKillSwitchStatePort {
    return createKillSwitch({ active: false, updatedAt: 1_000 });
  }

  it('parses canary configuration from environment defaults to dry-run', () => {
    const config = parseCanaryTradeConfigFromEnv({
      CANARY_TOKEN_ID: '1234567890',
      CANARY_SIDE: 'buy',
      CANARY_SIZE: '2',
      CANARY_PRICE: '0.4',
    });

    expect(config).toMatchObject({
      tokenId: '1234567890',
      side: 'buy',
      size: 2,
      price: 0.4,
      dryRun: true,
      tradingEnabled: false,
      maxNotionalUsd: CANARY_HARD_MAX_NOTIONAL_USD,
      pollIntervalMs: DEFAULT_CANARY_POLL_INTERVAL_MS,
      pollTimeoutMs: DEFAULT_CANARY_POLL_TIMEOUT_MS,
    });
  });

  it('returns a dry-run result without requiring a trading client', async () => {
    const result = await runCanaryTrade(createConfig());

    expect(result.submitted).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.orderRequest).toMatchObject({
      marketId: '1234567890',
      side: 'buy',
      size: 2,
      price: 0.4,
      orderType: 'limit',
      timeInForce: 'GTC',
    });
  });

  it('uses collision-resistant run ids when canaries start in the same millisecond', async () => {
    const persistence = createPersistence();
    const first = await runCanaryTrade(createConfig(), undefined, {
      persistence,
      now: () => 1_000,
    });
    const second = await runCanaryTrade(createConfig(), undefined, {
      persistence,
      now: () => 1_000,
    });

    expect(first.record.runId).not.toBe(second.record.runId);
    expect(first.record.runId).toMatch(/^canary-1000-/);
    expect(second.record.runId).toMatch(/^canary-1000-/);
  });

  it('rejects real submission unless the trading flag and confirmation are both present', async () => {
    const client = createClient();

    await expect(
      runCanaryTrade(createConfig({ dryRun: false, tradingEnabled: true }), client)
    ).rejects.toThrow(/CANARY_CONFIRMATION/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects real submission when the canary kill switch is active', async () => {
    const client = createClient();
    const persistence = createPersistence();
    const killSwitch = createKillSwitch({
      active: true,
      updatedAt: 5_000,
      reason: 'emergency stop',
    });

    await expect(
      runCanaryTrade(
        createConfig({
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        {
          persistence,
          killSwitch,
          now: () => 10_000,
        }
      )
    ).rejects.toThrow(/kill switch/i);

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(persistence.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        submitted: false,
        lastError: 'Canary kill switch is active: emergency stop',
      })
    );
  });

  it('rejects canary orders above the hard notional cap', async () => {
    const client = createClient();

    await expect(
      runCanaryTrade(
        createConfig({
          size: CANARY_HARD_MAX_NOTIONAL_USD + 1,
          price: 0.99,
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client
      )
    ).rejects.toThrow(/exceeds/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('does not submit when the initial CLOB heartbeat cannot be confirmed', async () => {
    const client = createClient() as TradingClient & { startHeartbeat: jest.Mock };
    client.startHeartbeat.mockRejectedValueOnce(new Error('heartbeat unavailable'));
    const persistence = createPersistence();

    await expect(
      runCanaryTrade(
        createConfig({
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        { persistence, killSwitch: createInactiveKillSwitch() }
      )
    ).rejects.toThrow(/heartbeat unavailable/);

    expect(client.placeOrder).not.toHaveBeenCalled();
    expect(persistence.saveRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', submissionAttempted: false })
    );
  });

  it('does not submit while the authenticated account has an existing open order', async () => {
    const client = createClient() as TradingClient & { getOpenOrders: jest.Mock };
    client.getOpenOrders.mockResolvedValue([{ id: 'existing-order' }]);

    await expect(
      runCanaryTrade(
        createConfig({
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        { persistence: createPersistence(), killSwitch: createInactiveKillSwitch() }
      )
    ).rejects.toThrow(/zero existing open orders/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('requires collateral and allowance headroom for the maximum platform fee', async () => {
    const client = createClient() as TradingClient & {
      getCollateralBalance: jest.Mock;
    };
    client.getCollateralBalance.mockResolvedValue({
      size: 0.81,
      allowances: { exchange: 0.81 },
    });

    await expect(
      runCanaryTrade(
        createConfig({
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        { persistence: createPersistence(), killSwitch: createInactiveKillSwitch() }
      )
    ).rejects.toThrow(/collateral/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('requires a sufficient token allowance before a canary sell', async () => {
    const client = createClient() as TradingClient & { getBalances: jest.Mock };
    client.getBalances.mockResolvedValue([
      { assetId: '1234567890', size: 100, allowances: { exchange: 1 } },
    ]);

    await expect(
      runCanaryTrade(
        createConfig({
          side: 'sell',
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        { persistence: createPersistence(), killSwitch: createInactiveKillSwitch() }
      )
    ).rejects.toThrow(/allowance/);
    expect(client.placeOrder).not.toHaveBeenCalled();
  });

  it('submits exactly one GTC limit order when all real-trading gates are satisfied', async () => {
    const client = createClient();
    const persistence = createPersistence();
    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      { persistence, killSwitch: createInactiveKillSwitch() }
    );

    expect(client.placeOrder).toHaveBeenCalledTimes(1);
    expect(client.placeOrder).toHaveBeenCalledWith({
      idempotencyKey: expect.stringMatching(/^canary-/),
      marketId: '1234567890',
      side: 'buy',
      size: 2,
      price: 0.4,
      orderType: 'limit',
      timeInForce: 'GTC',
    });
    expect(result.submitted).toBe(true);
    expect(result.order?.id).toBe('0xorder');
    expect(persistence.saveRecord).toHaveBeenCalled();
  });

  it('cancels an in-flight canary when the kill switch activates during polling', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'cancelled',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:01.000Z',
      }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const killSwitch = createKillSwitch({ active: false, updatedAt: 1_000 });
    (killSwitch.loadState as jest.Mock)
      .mockReturnValueOnce({ active: false, updatedAt: 1_000 })
      .mockReturnValue({ active: true, updatedAt: 2_000, reason: 'operator stop' });

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence: createPersistence(),
        killSwitch,
        sleep: async () => {},
        now: () => 3_000,
        pollIntervalMs: 1,
        pollTimeoutMs: 5_000,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(client.getOrder).toHaveBeenCalledTimes(1);
    expect(result.record).toMatchObject({
      status: 'cancelled',
      cancelAttempted: true,
      cancelSucceeded: true,
      cancelConfirmed: true,
      manualInterventionRequired: false,
    });
  });

  it('polls an open canary order until it becomes filled and persists the final state', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest
        .fn()
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'open',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:01.000Z',
        })
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'filled',
          filledSize: 2,
          remainingSize: 0,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:02.000Z',
        }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1000;
          return () => {
            current += 1000;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 5_000,
      }
    );

    expect((client as TradingClient & { getOrder: jest.Mock }).getOrder).toHaveBeenCalledTimes(2);
    expect(result.order?.status).toBe('filled');
    expect(persistence.saveRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        orderId: '0xorder',
        status: 'filled',
        submitted: true,
      })
    );
  });

  it('persists an unknown record when a network submission has an ambiguous outcome', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockRejectedValue(new Error('exchange unavailable')),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const persistence = createPersistence();

    await expect(
      runCanaryTrade(
        createConfig({
          dryRun: false,
          tradingEnabled: true,
          confirmation: CANARY_CONFIRMATION_PHRASE,
        }),
        client,
        {
          persistence,
          killSwitch: createInactiveKillSwitch(),
          now: () => 1_000,
        }
      )
    ).rejects.toThrow(/exchange unavailable/);

    expect(persistence.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'unknown',
        submitted: false,
        submissionAttempted: true,
        manualInterventionRequired: true,
        lastError: 'exchange unavailable',
      })
    );
  });

  it('cancels a partially filled canary order and marks it for manual intervention', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'partial',
        filledSize: 0.5,
        remainingSize: 1.5,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:01.000Z',
      }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1000;
          return () => {
            current += 1000;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 5_000,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledWith('0xorder');
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'partial',
        cancelAttempted: true,
        cancelSucceeded: true,
        manualInterventionRequired: true,
      })
    );
    expect(persistence.saveRecord).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        cancelAttempted: true,
        cancelSucceeded: true,
        manualInterventionRequired: true,
      })
    );
  });

  it('marks manual intervention when cancelling the remainder of a partial fill fails', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'partial',
        filledSize: 0.5,
        remainingSize: 1.5,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      cancelOrder: jest.fn().mockRejectedValue(new Error('cancel rejected')),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        now: () => 1_000,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledWith('0xorder');
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'partial',
        cancelAttempted: true,
        cancelSucceeded: false,
        manualInterventionRequired: true,
        cancelError: 'cancel rejected',
      })
    );
  });

  it('cancels and confirms a timed out open canary order before clearing manual intervention', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest
        .fn()
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'open',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:01.000Z',
        })
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'cancelled',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:02.000Z',
        }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1_000;
          return () => {
            current += 1;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledWith('0xorder');
    expect((client as TradingClient & { getOrder: jest.Mock }).getOrder).toHaveBeenCalledTimes(2);
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        cancelAttempted: true,
        cancelSucceeded: true,
        cancelConfirmed: true,
        manualInterventionRequired: false,
      })
    );
  });

  it('does not cancel a timed-out order twice when cancellation polling finds a partial fill', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest
        .fn()
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'open',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:01.000Z',
        })
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'partial',
          filledSize: 0.5,
          remainingSize: 1.5,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:02.000Z',
        }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence: createPersistence(),
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1_000;
          return () => {
            current += 1;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledTimes(1);
    expect(result.record).toMatchObject({
      status: 'partial',
      cancelAttempted: true,
      cancelSucceeded: true,
      cancelConfirmed: true,
      manualInterventionRequired: true,
    });
  });

  it('marks manual intervention when a timed out open canary order cannot be cancelled', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:01.000Z',
      }),
      cancelOrder: jest.fn().mockRejectedValue(new Error('cancel timeout')),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1_000;
          return () => {
            current += 1;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledWith('0xorder');
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'timed_out',
        cancelAttempted: true,
        cancelSucceeded: false,
        manualInterventionRequired: true,
        cancelError: 'cancel timeout',
      })
    );
  });

  it('keeps manual intervention on when timeout cancellation is not confirmed', async () => {
    const client = makeSafeClient({
      placeOrder: jest.fn().mockResolvedValue({
        id: '0xorder',
        marketId: '1234567890',
        side: 'buy',
        size: 2,
        price: 0.4,
        status: 'open',
        filledSize: 0,
        remainingSize: 2,
        createdAt: '2026-04-23T00:00:00.000Z',
        updatedAt: '2026-04-23T00:00:00.000Z',
      }),
      getOrder: jest
        .fn()
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'open',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:01.000Z',
        })
        .mockResolvedValueOnce({
          id: '0xorder',
          marketId: '1234567890',
          side: 'buy',
          size: 2,
          price: 0.4,
          status: 'open',
          filledSize: 0,
          remainingSize: 2,
          createdAt: '2026-04-23T00:00:00.000Z',
          updatedAt: '2026-04-23T00:00:02.000Z',
        }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    });
    const persistence = createPersistence();

    const result = await runCanaryTrade(
      createConfig({
        dryRun: false,
        tradingEnabled: true,
        confirmation: CANARY_CONFIRMATION_PHRASE,
      }),
      client,
      {
        persistence,
        killSwitch: createInactiveKillSwitch(),
        sleep: async () => {},
        now: (() => {
          let current = 1_000;
          return () => {
            current += 1;
            return current;
          };
        })(),
        pollIntervalMs: 1,
        pollTimeoutMs: 1,
      }
    );

    expect(client.cancelOrder).toHaveBeenCalledWith('0xorder');
    expect(result.record).toEqual(
      expect.objectContaining({
        status: 'timed_out',
        cancelAttempted: true,
        cancelSucceeded: true,
        cancelConfirmed: false,
        manualInterventionRequired: true,
      })
    );
  });
});
