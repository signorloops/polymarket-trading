/**
 * Polymarket API Client
 *
 * Provides interface to Polymarket REST API for:
 * - Market data retrieval
 * - Order placement and cancellation
 * - Account balance queries
 * - Trade history
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG } from '../utils/config.js';

export interface PolymarketMarket {
  id: string;
  slug: string;
  question: string;
  description: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  active: boolean;
  closed: boolean;
  marketStartDate?: string;
  marketEndDate?: string;
}

export interface OrderRequest {
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType?: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface OrderResponse {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  filledSize: number;
  remainingSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface Balance {
  assetId: string;
  symbol: string;
  balance: string;
  available: string;
  locked: string;
}

export interface Trade {
  id: string;
  marketId: string;
  orderId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  fee: number;
  timestamp: string;
}

export class PolymarketClient {
  private client: AxiosInstance;
  private logger = getLogger().child({ module: 'PolymarketClient' });
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? NETWORK_CONFIG.POLYMARKET_API_KEY;

    this.client = axios.create({
      baseURL: 'https://api.polymarket.com',
      timeout: NETWORK_CONFIG.CONNECTION_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        this.logger.debug(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        this.logger.error('Request error', { error: error.message });
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error: AxiosError) => {
        this.handleApiError(error);
        return Promise.reject(error);
      }
    );
  }

  private handleApiError(error: AxiosError): void {
    if (error.response) {
      const { status, data } = error.response;
      this.logger.error(`API Error ${status}`, { data, url: error.config?.url });

      switch (status) {
        case 401:
          throw new Error('Authentication failed: Invalid API key');
        case 403:
          throw new Error('Authorization failed: Insufficient permissions');
        case 429:
          throw new Error('Rate limit exceeded');
        case 500:
        case 502:
        case 503:
          throw new Error('Polymarket API is temporarily unavailable');
        default:
          throw new Error(`API Error: ${status} - ${JSON.stringify(data)}`);
      }
    } else if (error.request) {
      this.logger.error('Network error', { error: error.message });
      throw new Error('Network error: Unable to reach Polymarket API');
    } else {
      this.logger.error('Request setup error', { error: error.message });
      throw error;
    }
  }

  /**
   * Get all active markets
   */
  async getMarkets(params?: {
    active?: boolean;
    closed?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<PolymarketMarket[]> {
    const response = await this.client.get('/markets', { params });
    return response.data;
  }

  /**
   * Get specific market by ID
   */
  async getMarket(marketId: string): Promise<PolymarketMarket> {
    const response = await this.client.get(`/markets/${marketId}`);
    return response.data;
  }

  /**
   * Get order book for a market
   */
  async getOrderBook(marketId: string): Promise<{
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
    timestamp: string;
  }> {
    const response = await this.client.get(`/markets/${marketId}/orderbook`);
    return response.data;
  }

  /**
   * Place a new order
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const response = await this.client.post('/orders', order);
    return response.data;
  }

  /**
   * Cancel an existing order
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.client.delete(`/orders/${orderId}`);
  }

  /**
   * Get order details
   */
  async getOrder(orderId: string): Promise<OrderResponse> {
    const response = await this.client.get(`/orders/${orderId}`);
    return response.data;
  }

  /**
   * Get all open orders
   */
  async getOpenOrders(marketId?: string): Promise<OrderResponse[]> {
    const params = marketId ? { marketId } : {};
    const response = await this.client.get('/orders', { params });
    return response.data;
  }

  /**
   * Get account balances
   */
  async getBalances(): Promise<Balance[]> {
    const response = await this.client.get('/balance');
    return response.data;
  }

  /**
   * Get trade history
   */
  async getTrades(params?: {
    marketId?: string;
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<Trade[]> {
    const response = await this.client.get('/trades', { params });
    return response.data;
  }

  /**
   * Get market prices (time series)
   */
  async getMarketPrices(
    marketId: string,
    params?: {
      startDate?: string;
      endDate?: string;
      interval?: '1m' | '5m' | '15m' | '1h' | '1d';
    }
  ): Promise<Array<{ timestamp: string; price: string; volume: string }>> {
    const response = await this.client.get(`/markets/${marketId}/prices`, { params });
    return response.data;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/health');
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton instance
let globalClient: PolymarketClient | null = null;

export function getPolymarketClient(apiKey?: string): PolymarketClient {
  if (!globalClient) {
    globalClient = new PolymarketClient(apiKey);
  }
  return globalClient;
}

export function resetPolymarketClient(): void {
  globalClient = null;
}
