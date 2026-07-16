/**
 * Unit tests for Polymarket REST API Client
 */

import { jest } from '@jest/globals';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type {
  PolymarketMarket,
  OrderRequest,
  OrderResponse,
} from '../../src/api/polymarket-client.js';

// Mock axios
const mockAxiosInstance = {
  get: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
  interceptors: {
    request: { use: jest.fn().mockReturnValue(0), eject: jest.fn() },
    response: { use: jest.fn().mockReturnValue(0), eject: jest.fn() },
  },
  defaults: { headers: { common: {} } },
};

jest.unstable_mockModule('axios', () => ({
  default: {
    create: jest.fn(() => mockAxiosInstance),
  },
  create: jest.fn(() => mockAxiosInstance),
}));

// Mock logger
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: jest.fn(() => ({
    child: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
  createSilentLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(() => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

// Mock config
jest.unstable_mockModule('../../src/utils/config.js', () => ({
  NETWORK_CONFIG: {
    POLYMARKET_API_KEY: 'test-api-key',
    POLYMARKET_SECRET: 'test-secret',
    POLYMARKET_PASSPHRASE: 'test-passphrase',
    CONNECTION_TIMEOUT: 30000,
  },
}));

// Import after mocks
const { PolymarketClient, getPolymarketClient, resetPolymarketClient } =
  await import('../../src/api/polymarket-client.js');

describe('PolymarketClient', () => {
  let client: InstanceType<typeof PolymarketClient>;

  const mockMarket: PolymarketMarket = {
    id: 'market-1',
    slug: 'test-market',
    question: 'Will it rain tomorrow?',
    description: 'Test market description',
    outcomes: ['Yes', 'No'],
    outcomePrices: ['0.6', '0.4'],
    volume: '10000',
    liquidity: '5000',
    active: true,
    closed: false,
    marketStartDate: '2024-01-01',
    marketEndDate: '2024-12-31',
  };

  const mockOrderResponse: OrderResponse = {
    id: 'order-1',
    marketId: 'market-1',
    side: 'buy',
    size: 100,
    price: 0.6,
    status: 'open',
    filledSize: 0,
    remainingSize: 100,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resetPolymarketClient();

    // Reset mock axios instance methods
    mockAxiosInstance.get.mockReset();
    mockAxiosInstance.post.mockReset();
    mockAxiosInstance.delete.mockReset();
    mockAxiosInstance.interceptors.request.use.mockClear();
    mockAxiosInstance.interceptors.response.use.mockClear();

    // Restore mock implementations
    mockAxiosInstance.interceptors.request.use.mockReturnValue(0);
    mockAxiosInstance.interceptors.response.use.mockReturnValue(0);

    client = new PolymarketClient({
      apiKey: 'test-api-key',
      secret: 'test-secret',
      passphrase: 'test-passphrase',
    });
  });

  afterEach(() => {
    resetPolymarketClient();
  });

  describe('constructor', () => {
    it('should setup request and response interceptors', () => {
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalledTimes(1);
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalledTimes(1);
    });
  });

  describe('public endpoint authentication isolation', () => {
    it('does not leak trading credentials to public Gamma requests', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockMarket] });

      await client.getMarkets();

      const requestInterceptor = mockAxiosInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: { set: jest.fn() } } as unknown as InternalAxiosRequestConfig;

      requestInterceptor(config);

      expect(config.headers.set).not.toHaveBeenCalled();
    });
  });

  describe('getMarkets', () => {
    it('should fetch all markets without params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockMarket] });

      const result = await client.getMarkets();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets', { params: undefined });
      expect(result).toEqual([mockMarket]);
    });

    it('should fetch markets with query params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockMarket] });

      const params = { active: true, limit: 10, offset: 0 };
      await client.getMarkets(params);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets', { params });
    });

    it('should handle empty markets response', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [] });

      const result = await client.getMarkets();

      expect(result).toEqual([]);
    });
  });

  describe('getMarket', () => {
    it('should fetch specific market by id', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockMarket });

      const result = await client.getMarket('market-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets/market-1');
      expect(result).toEqual(mockMarket);
    });

    it('rejects an empty market id before issuing a request', async () => {
      await expect(client.getMarket('  ')).rejects.toThrow(/marketId is required/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getOrderBook', () => {
    const mockOrderBook = {
      bids: [{ price: '0.6', size: '100' }],
      asks: [{ price: '0.65', size: '50' }],
      timestamp: '2024-01-01T00:00:00Z',
    };

    it('should fetch order book for market', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrderBook });

      const result = await client.getOrderBook('1234567890');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('https://clob.polymarket.com/book', {
        params: { token_id: '1234567890' },
      });
      expect(result).toEqual(mockOrderBook);
    });

    it('should handle empty order book', async () => {
      const emptyOrderBook = {
        bids: [],
        asks: [],
        timestamp: '2024-01-01T00:00:00Z',
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: emptyOrderBook });

      const result = await client.getOrderBook('1234567890');

      expect(result.bids).toEqual([]);
      expect(result.asks).toEqual([]);
    });

    it('rejects a Gamma market id where a numeric CLOB token id is required', async () => {
      await expect(client.getOrderBook('market-1')).rejects.toThrow(/numeric.*token id/i);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getTakerFeeSchedule', () => {
    const tokenId = '1234567890';
    const conditionId = `0x${'a'.repeat(64)}`;

    it('resolves V2 fee rate and exponent for the requested token', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            condition_id: conditionId,
            primary_token_id: tokenId,
            secondary_token_id: '999',
          },
        })
        .mockResolvedValueOnce({
          data: {
            c: conditionId,
            t: [
              { t: tokenId, o: 'Yes' },
              { t: '999', o: 'No' },
            ],
            mts: 0.01,
            r: null,
            fd: { r: 0.07, e: 2, to: true },
          },
        });

      const schedule = await client.getTakerFeeSchedule(tokenId);

      expect(schedule).toEqual({
        tokenId,
        conditionId,
        rate: 0.07,
        exponent: 2,
        fetchedAt: expect.any(Number),
      });
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(
        1,
        `https://clob.polymarket.com/markets-by-token/${tokenId}`
      );
      expect(mockAxiosInstance.get).toHaveBeenNthCalledWith(
        2,
        `https://clob.polymarket.com/clob-markets/${conditionId}`
      );
    });

    it('treats an omitted fee object as an explicit zero-fee market', async () => {
      mockAxiosInstance.get
        .mockResolvedValueOnce({
          data: {
            condition_id: conditionId,
            primary_token_id: tokenId,
            secondary_token_id: '999',
          },
        })
        .mockResolvedValueOnce({
          data: { c: conditionId, t: [{ t: tokenId }, { t: '999' }], mts: 0.01, r: null },
        });

      await expect(client.getTakerFeeSchedule(tokenId)).resolves.toMatchObject({
        rate: 0,
        exponent: 0,
      });
    });

    it('rejects mismatched or unsafe fee metadata', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({
        data: {
          condition_id: conditionId,
          primary_token_id: 'not-the-requested-token',
          secondary_token_id: '999',
        },
      });
      await expect(client.getTakerFeeSchedule(tokenId)).rejects.toThrow(/does not match/);
    });
  });

  describe('placeOrder', () => {
    const orderRequest: OrderRequest = {
      marketId: 'market-1',
      side: 'buy',
      size: 100,
      price: 0.6,
      orderType: 'limit',
      timeInForce: 'GTC',
    };

    it('should reject unsigned direct order placement', async () => {
      await expect(client.placeOrder(orderRequest)).rejects.toThrow(/signed CLOB order/);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });

    it('should reject unsigned market order placement', async () => {
      const marketOrder: OrderRequest = {
        marketId: 'market-1',
        side: 'sell',
        size: 50,
        price: 0,
        orderType: 'market',
      };
      await expect(client.placeOrder(marketOrder)).rejects.toThrow(/signed CLOB order/);

      expect(mockAxiosInstance.post).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrder', () => {
    it('should reject direct cancellation without CLOB L2 signing', async () => {
      await expect(client.cancelOrder('order-1')).rejects.toThrow(/CLOB client/);

      expect(mockAxiosInstance.delete).not.toHaveBeenCalled();
    });
  });

  describe('getOrder', () => {
    it('requires the signed V2 adapter', async () => {
      await expect(client.getOrder('order-1')).rejects.toThrow(/signed CLOB V2/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getOpenOrders', () => {
    it('requires the signed V2 adapter without a filter', async () => {
      await expect(client.getOpenOrders()).rejects.toThrow(/signed CLOB V2/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('requires the signed V2 adapter with a filter', async () => {
      await expect(client.getOpenOrders('market-1')).rejects.toThrow(/signed CLOB V2/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getBalances', () => {
    it('requires the signed V2 adapter', async () => {
      await expect(client.getBalances()).rejects.toThrow(/signed CLOB V2/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getTrades', () => {
    it('requires an explicit user identity or signed client', async () => {
      await expect(client.getTrades()).rejects.toThrow(/explicit Data API user/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('should fetch trades with filters', async () => {
      const params = {
        marketId: 'market-1',
        limit: 50,
        offset: 0,
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      };
      await expect(client.getTrades(params)).rejects.toThrow(/explicit Data API user/);
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });
  });

  describe('getMarketPrices', () => {
    const mockHistory = { history: [{ t: 1_704_067_200, p: 0.6 }] };

    it('should fetch market prices without params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockHistory });

      const result = await client.getMarketPrices('1234567890');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        'https://clob.polymarket.com/prices-history',
        {
          params: { market: '1234567890' },
        }
      );
      expect(result).toEqual([
        {
          timestamp: '2024-01-01T00:00:00.000Z',
          price: '0.6',
          volume: '',
        },
      ]);
    });

    it('should fetch market prices with an official interval', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockHistory });

      await client.getMarketPrices('1234567890', { interval: '1h' });

      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        'https://clob.polymarket.com/prices-history',
        {
          params: { market: '1234567890', interval: '1h' },
        }
      );
    });

    it('should fetch an absolute date range using unix seconds', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockHistory });
      await client.getMarketPrices('1234567890', {
        startDate: '2024-01-01',
        endDate: '2024-01-02',
      });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        'https://clob.polymarket.com/prices-history',
        {
          params: {
            market: '1234567890',
            startTs: 1_704_067_200,
            endTs: 1_704_153_600,
          },
        }
      );
    });

    it('supports the official fidelity parameter', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockHistory });
      await client.getMarketPrices('1234567890', { interval: 'all', fidelity: 5 });
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        'https://clob.polymarket.com/prices-history',
        { params: { market: '1234567890', interval: 'all', fidelity: 5 } }
      );
    });

    it('rejects contradictory or invalid history ranges locally', async () => {
      await expect(
        client.getMarketPrices('1234567890', {
          interval: '1h',
          startDate: '2024-01-01',
        })
      ).rejects.toThrow(/cannot be combined/);
      await expect(
        client.getMarketPrices('1234567890', {
          startDate: '2024-01-02',
          endDate: '2024-01-01',
        })
      ).rejects.toThrow(/must be before/);
      await expect(client.getMarketPrices('1234567890', { fidelity: 0 })).rejects.toThrow(
        /positive integer/
      );
      expect(mockAxiosInstance.get).not.toHaveBeenCalled();
    });

    it('rejects malformed public API data', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: { history: [{ t: 1, p: 2 }] } });
      await expect(client.getMarketPrices('1234567890')).rejects.toThrow(/invalid point/);
    });
  });

  describe('healthCheck', () => {
    it('should return true when API is healthy', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });

      const result = await client.healthCheck();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('https://clob.polymarket.com/ok');
      expect(result).toBe(true);
    });

    it('should return false when API is unhealthy', async () => {
      mockAxiosInstance.get.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await client.healthCheck();

      expect(result).toBe(false);
    });
  });

  describe('error handling', () => {
    const createAxiosError = (status: number, data?: unknown): AxiosError => {
      const error = new Error(`Request failed with status code ${status}`) as AxiosError;
      error.response = {
        status,
        data,
        headers: {},
        config: { url: '/test' } as InternalAxiosRequestConfig,
      };
      error.config = { url: '/test' } as InternalAxiosRequestConfig;
      return error;
    };

    it('should throw authentication error on 401', () => {
      const error = createAxiosError(401);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Authentication failed: Invalid API key');
    });

    it('should throw authorization error on 403', () => {
      const error = createAxiosError(403);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Authorization failed: Insufficient permissions');
    });

    it('should throw rate limit error on 429', () => {
      const error = createAxiosError(429);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Rate limit exceeded');
    });

    it('should throw service unavailable error on 500', () => {
      const error = createAxiosError(500);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Polymarket API is temporarily unavailable');
    });

    it('should throw service unavailable error on 502', () => {
      const error = createAxiosError(502);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Polymarket API is temporarily unavailable');
    });

    it('should throw service unavailable error on 503', () => {
      const error = createAxiosError(503);
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Polymarket API is temporarily unavailable');
    });

    it('should throw generic error for other status codes', () => {
      const error = createAxiosError(400, { message: 'Bad request' });
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('API Error: 400');
    });

    it('should throw network error when no response', () => {
      const error = new Error('Network Error') as AxiosError;
      error.request = {};
      error.message = 'Network Error';
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Network error: Unable to reach Polymarket API');
    });

    it('should rethrow request setup errors', () => {
      const error = new Error('Request setup failed') as AxiosError;
      error.message = 'Request setup failed';
      const errorHandler = mockAxiosInstance.interceptors.response.use.mock.calls[0][1];

      expect(() => errorHandler(error)).toThrow('Request setup failed');
    });
  });

  describe('request interceptor error', () => {
    it('should handle request interceptor errors', async () => {
      const errorHandler = mockAxiosInstance.interceptors.request.use.mock.calls[0][1];
      const error = new Error('Request failed');

      await expect(errorHandler(error)).rejects.toThrow('Request failed');
    });

    it('should handle non-Error request failures', async () => {
      const errorHandler = mockAxiosInstance.interceptors.request.use.mock.calls[0][1];
      const nonErrorFailure = 'string error';

      await expect(errorHandler(nonErrorFailure)).rejects.toThrow('Unknown error');
    });
  });

  describe('singleton', () => {
    it('getPolymarketClient should return same instance', () => {
      const client1 = getPolymarketClient('api-key-1');
      const client2 = getPolymarketClient('api-key-2');

      expect(client1).toBe(client2);
    });

    it('resetPolymarketClient should clear instance', () => {
      const client1 = getPolymarketClient('api-key');
      resetPolymarketClient();
      const client2 = getPolymarketClient('api-key');

      expect(client1).not.toBe(client2);
    });

    it('getPolymarketClient should work without api key', () => {
      resetPolymarketClient();
      const client = getPolymarketClient();

      expect(client).toBeDefined();
    });
  });
});
