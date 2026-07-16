/**
 * Unit tests for Polymarket REST API Client
 */

import { jest } from '@jest/globals';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type {
  PolymarketMarket,
  OrderRequest,
  OrderResponse,
  Balance,
  Trade,
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

  const mockBalance: Balance = {
    assetId: 'asset-1',
    symbol: 'USDC',
    balance: '1000',
    available: '800',
    locked: '200',
  };

  const mockTrade: Trade = {
    id: 'trade-1',
    marketId: 'market-1',
    orderId: 'order-1',
    side: 'buy',
    size: 100,
    price: 0.6,
    fee: 0.5,
    timestamp: '2024-01-01T00:00:00Z',
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

  describe('authentication', () => {
    it('should add CLOB API key header without bearer auth', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockMarket] });

      await client.getMarkets();

      const requestInterceptor = mockAxiosInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: { set: jest.fn() } } as unknown as InternalAxiosRequestConfig;

      requestInterceptor(config);

      expect(config.headers.set).toHaveBeenCalledWith('POLY_API_KEY', 'test-api-key');
      expect(config.headers.set).not.toHaveBeenCalledWith('Authorization', expect.any(String));
    });

    it('should add timestamp and passphrase headers when secret provided', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockMarket] });

      await client.getMarkets();

      const requestInterceptor = mockAxiosInstance.interceptors.request.use.mock.calls[0][0];
      const config = { headers: { set: jest.fn() } } as unknown as InternalAxiosRequestConfig;

      requestInterceptor(config);

      expect(config.headers.set).toHaveBeenCalledWith('POLY_API_KEY', 'test-api-key');
      expect(config.headers.set).toHaveBeenCalledWith('POLY_PASSPHRASE', 'test-passphrase');
      expect(config.headers.set).toHaveBeenCalledWith('POLY_TIMESTAMP', expect.any(String));
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
  });

  describe('getOrderBook', () => {
    const mockOrderBook = {
      bids: [{ price: '0.6', size: '100' }],
      asks: [{ price: '0.65', size: '50' }],
      timestamp: '2024-01-01T00:00:00Z',
    };

    it('should fetch order book for market', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrderBook });

      const result = await client.getOrderBook('market-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets/market-1/orderbook');
      expect(result).toEqual(mockOrderBook);
    });

    it('should handle empty order book', async () => {
      const emptyOrderBook = {
        bids: [],
        asks: [],
        timestamp: '2024-01-01T00:00:00Z',
      };
      mockAxiosInstance.get.mockResolvedValueOnce({ data: emptyOrderBook });

      const result = await client.getOrderBook('market-1');

      expect(result.bids).toEqual([]);
      expect(result.asks).toEqual([]);
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
    it('should fetch order details', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockOrderResponse });

      const result = await client.getOrder('order-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/orders/order-1');
      expect(result).toEqual(mockOrderResponse);
    });
  });

  describe('getOpenOrders', () => {
    it('should fetch all open orders without market filter', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockOrderResponse] });

      const result = await client.getOpenOrders();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/orders', { params: {} });
      expect(result).toEqual([mockOrderResponse]);
    });

    it('should fetch open orders for specific market', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockOrderResponse] });

      await client.getOpenOrders('market-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/orders', {
        params: { marketId: 'market-1' },
      });
    });
  });

  describe('getBalances', () => {
    it('should fetch account balances', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockBalance] });

      const result = await client.getBalances();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/balance');
      expect(result).toEqual([mockBalance]);
    });

    it('should handle multiple balances', async () => {
      const balances: Balance[] = [
        mockBalance,
        { ...mockBalance, assetId: 'asset-2', symbol: 'ETH' },
      ];
      mockAxiosInstance.get.mockResolvedValueOnce({ data: balances });

      const result = await client.getBalances();

      expect(result).toHaveLength(2);
    });
  });

  describe('getTrades', () => {
    it('should fetch trades without params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockTrade] });

      const result = await client.getTrades();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/trades', { params: undefined });
      expect(result).toEqual([mockTrade]);
    });

    it('should fetch trades with filters', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: [mockTrade] });

      const params = {
        marketId: 'market-1',
        limit: 50,
        offset: 0,
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      };
      await client.getTrades(params);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/trades', { params });
    });
  });

  describe('getMarketPrices', () => {
    const mockPrices = [
      { timestamp: '2024-01-01T00:00:00Z', price: '0.6', volume: '100' },
      { timestamp: '2024-01-01T01:00:00Z', price: '0.65', volume: '150' },
    ];

    it('should fetch market prices without params', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockPrices });

      const result = await client.getMarketPrices('market-1');

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets/market-1/prices', {
        params: undefined,
      });
      expect(result).toEqual(mockPrices);
    });

    it('should fetch market prices with interval', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: mockPrices });

      const params = {
        startDate: '2024-01-01',
        endDate: '2024-01-02',
        interval: '1h' as const,
      };
      await client.getMarketPrices('market-1', params);

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/markets/market-1/prices', {
        params,
      });
    });
  });

  describe('healthCheck', () => {
    it('should return true when API is healthy', async () => {
      mockAxiosInstance.get.mockResolvedValueOnce({ data: {} });

      const result = await client.healthCheck();

      expect(mockAxiosInstance.get).toHaveBeenCalledWith('/health');
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
