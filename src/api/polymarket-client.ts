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
import { createSingleton } from '../utils/singleton.js';

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

export interface PolymarketCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
}

export class PolymarketClient {
  private client: AxiosInstance;
  private logger = getLogger().child({ module: 'PolymarketClient' });
  private credentials: PolymarketCredentials;

  constructor(credentials?: Partial<PolymarketCredentials>) {
    this.credentials = {
      apiKey: credentials?.apiKey ?? NETWORK_CONFIG.POLYMARKET_API_KEY ?? '',
      secret: credentials?.secret ?? NETWORK_CONFIG.POLYMARKET_SECRET ?? '',
      passphrase: credentials?.passphrase ?? NETWORK_CONFIG.POLYMARKET_PASSPHRASE ?? '',
    };

    this.client = axios.create({
      baseURL: 'https://api.polymarket.com',
      timeout: NETWORK_CONFIG.CONNECTION_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - add authentication headers
    this.client.interceptors.request.use(
      (config) => {
        // Add authentication headers if credentials are configured
        if (this.credentials.apiKey) {
          config.headers.set('Authorization', `Bearer ${this.credentials.apiKey}`);

          // Add additional security headers if secret and passphrase are provided
          if (this.credentials.secret && this.credentials.passphrase) {
            const timestamp = Date.now().toString();
            config.headers.set('POLYMARKET-TIMESTAMP', timestamp);
            config.headers.set('POLYMARKET-PASSPHRASE', this.credentials.passphrase);
          }
        }

        this.logger.debug(`API Request: ${String(config.method?.toUpperCase())} ${String(config.url)}`);
        return config;
      },
      (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error('Request error', { error: errorMessage });
        return Promise.reject(new Error(errorMessage));
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        this.logger.debug(`API Response: ${String(response.status)} ${String(response.config.url)}`);
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
      this.logger.error(`API Error ${String(status)}`, { data, url: error.config?.url });

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
          throw new Error(`API Error: ${String(status)} - ${JSON.stringify(data)}`);
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
    const response = await this.client.get<PolymarketMarket[]>('/markets', { params });
    return response.data;
  }

  /**
   * Get specific market by ID
   */
  async getMarket(marketId: string): Promise<PolymarketMarket> {
    const response = await this.client.get<PolymarketMarket>(`/markets/${marketId}`);
    return response.data;
  }

  /**
   * Get order book for a market
   */
  async getOrderBook(marketId: string): Promise<{
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
    timestamp: string;
  }> {
    const response = await this.client.get<{
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
      timestamp: string;
    }>(`/markets/${marketId}/orderbook`);
    return response.data;
  }

  /**
   * Place a new order
   */
  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    const response = await this.client.post<OrderResponse>('/orders', order);
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
    const response = await this.client.get<OrderResponse>(`/orders/${orderId}`);
    return response.data;
  }

  /**
   * Get all open orders
   */
  async getOpenOrders(marketId?: string): Promise<OrderResponse[]> {
    const params = marketId ? { marketId } : {};
    const response = await this.client.get<OrderResponse[]>('/orders', { params });
    return response.data;
  }

  /**
   * Get account balances
   */
  async getBalances(): Promise<Balance[]> {
    const response = await this.client.get<Balance[]>('/balance');
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
    const response = await this.client.get<Trade[]>('/trades', { params });
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
  ): Promise<{ timestamp: string; price: string; volume: string }[]> {
    const response = await this.client.get<{ timestamp: string; price: string; volume: string }[]>(`/markets/${marketId}/prices`, { params });
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
const polymarketClientSingleton = createSingleton(() => new PolymarketClient());

export function getPolymarketClient(_apiKey?: string): PolymarketClient {
  return polymarketClientSingleton.get();
}

export const resetPolymarketClient = polymarketClientSingleton.reset;
