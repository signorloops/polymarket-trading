/**
 * Polymarket API Client
 *
 * Provides a credential-free interface to Polymarket's public Gamma and CLOB
 * market-data endpoints. Authenticated trading/account operations fail closed
 * and must use the signed CLOB V2 adapter.
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
  /** Unique logical order key, persisted before any signed real-money submission. */
  idempotencyKey?: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType?: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'FAK';
}

export interface OrderResponse {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  status: 'open' | 'partial' | 'filled' | 'cancelled' | 'rejected';
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

  constructor(_credentials?: Partial<PolymarketCredentials>) {
    this.client = axios.create({
      // Market discovery belongs to Gamma. CLOB reads below use absolute URLs;
      // authenticated order/account operations are deliberately delegated to
      // the official signed V2 adapter.
      baseURL: 'https://gamma-api.polymarket.com',
      timeout: NETWORK_CONFIG.CONNECTION_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors(): void {
    // Request interceptor - add authentication headers
    this.client.interceptors.request.use(
      (config) => {
        this.logger.debug(
          `API Request: ${String(config.method?.toUpperCase())} ${String(config.url)}`
        );
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
        this.logger.debug(
          `API Response: ${String(response.status)} ${String(response.config.url)}`
        );
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
    if (!marketId.trim()) throw new Error('marketId is required');
    const response = await this.client.get<PolymarketMarket>(
      `/markets/${encodeURIComponent(marketId)}`
    );
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
    assertTokenId(marketId);
    const response = await this.client.get<{
      bids: { price: string; size: string }[];
      asks: { price: string; size: string }[];
      timestamp: string;
    }>('https://clob.polymarket.com/book', { params: { token_id: marketId } });
    return response.data;
  }

  /**
   * Place a new order
   */
  placeOrder(order: OrderRequest): Promise<OrderResponse> {
    this.logger.error('Unsigned direct order placement is disabled', {
      marketId: order.marketId,
      side: order.side,
    });
    return Promise.reject(
      new Error(
        'Unsigned direct REST order placement is disabled. Use an official signed CLOB order client.'
      )
    );
  }

  /**
   * Cancel an existing order
   */
  cancelOrder(orderId: string): Promise<void> {
    this.logger.error('Direct order cancellation is disabled', { orderId });
    return Promise.reject(
      new Error('Direct REST order cancellation is disabled. Use an official signed CLOB client.')
    );
  }

  /**
   * Get order details
   */
  getOrder(orderId: string): Promise<OrderResponse> {
    return Promise.reject(
      new Error(
        `Authenticated order lookup for ${orderId} requires the official signed CLOB V2 client`
      )
    );
  }

  /**
   * Get all open orders
   */
  getOpenOrders(marketId?: string): Promise<OrderResponse[]> {
    return Promise.reject(
      new Error(
        `Authenticated open-order lookup${marketId ? ` for ${marketId}` : ''} requires the official signed CLOB V2 client`
      )
    );
  }

  /**
   * Get account balances
   */
  getBalances(): Promise<Balance[]> {
    return Promise.reject(
      new Error('Authenticated balances require the official signed CLOB V2 client')
    );
  }

  /**
   * Get trade history
   */
  getTrades(params?: {
    marketId?: string;
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<Trade[]> {
    return Promise.reject(
      new Error(
        `Trade history${params?.marketId ? ` for ${params.marketId}` : ''} requires an explicit Data API user or signed CLOB client`
      )
    );
  }

  /**
   * Get market prices (time series)
   */
  async getMarketPrices(
    marketId: string,
    params?: {
      startDate?: string;
      endDate?: string;
      interval?: 'max' | 'all' | '1m' | '1w' | '1d' | '6h' | '1h';
      fidelity?: number;
    }
  ): Promise<{ timestamp: string; price: string; volume: string }[]> {
    assertTokenId(marketId);
    if (params?.interval && (params.startDate || params.endDate)) {
      throw new Error('Price history interval cannot be combined with startDate/endDate');
    }
    if (
      params?.fidelity !== undefined &&
      (!Number.isInteger(params.fidelity) || params.fidelity < 1)
    ) {
      throw new Error('Price history fidelity must be a positive integer number of minutes');
    }
    const startTs = params?.startDate ? toUnixTimestamp(params.startDate, 'startDate') : undefined;
    const endTs = params?.endDate ? toUnixTimestamp(params.endDate, 'endDate') : undefined;
    if (startTs !== undefined && endTs !== undefined && startTs >= endTs) {
      throw new Error('Price history startDate must be before endDate');
    }
    const response = await this.client.get<unknown>('https://clob.polymarket.com/prices-history', {
      params: {
        market: marketId,
        ...(startTs !== undefined ? { startTs } : {}),
        ...(endTs !== undefined ? { endTs } : {}),
        ...(params?.interval ? { interval: params.interval } : {}),
        ...(params?.fidelity !== undefined ? { fidelity: params.fidelity } : {}),
      },
    });
    return parsePriceHistory(response.data).map((point) => ({
      timestamp: new Date(point.t * 1000).toISOString(),
      price: String(point.p),
      volume: '',
    }));
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('https://clob.polymarket.com/ok');
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

function assertTokenId(tokenId: string): void {
  if (!/^\d+$/.test(tokenId)) {
    throw new Error('A numeric Polymarket CLOB token id is required');
  }
}

function toUnixTimestamp(value: string, field: string): number {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${field} must be a valid date`);
  }
  return Math.floor(milliseconds / 1000);
}

function parsePriceHistory(value: unknown): { t: number; p: number }[] {
  if (!value || typeof value !== 'object' || !('history' in value)) {
    throw new Error('Polymarket price history response is malformed');
  }
  const history = (value as { history?: unknown }).history;
  if (!Array.isArray(history)) {
    throw new Error('Polymarket price history response is malformed');
  }
  return history.map((point) => {
    const timestamp = (point as { t?: unknown } | null)?.t;
    const price = (point as { p?: unknown } | null)?.p;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(price) ||
      (price as number) < 0 ||
      (price as number) > 1
    ) {
      throw new Error('Polymarket price history response contains an invalid point');
    }
    return { t: timestamp as number, p: price as number };
  });
}
