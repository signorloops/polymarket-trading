import type { OrderRequest, OrderResponse } from './polymarket-client.js';

export interface TradingClient {
  placeOrder(order: OrderRequest): Promise<OrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
}

export interface TradingStatusClient extends TradingClient {
  getOrder(orderId: string): Promise<OrderResponse>;
}

export interface TradingBalance {
  assetId: string;
  size: number;
  allowances?: Record<string, number>;
}

export interface TradingCollateralBalance {
  size: number;
  allowances: Record<string, number>;
}

export interface TradingBalanceClient extends TradingStatusClient {
  getBalances(assetIds: readonly string[]): Promise<TradingBalance[]>;
  getCollateralBalance(): Promise<TradingCollateralBalance>;
}

export interface TradingOpenOrdersClient extends TradingStatusClient {
  /** Return every currently open order for the authenticated account. */
  getOpenOrders(): Promise<OrderResponse[]>;
}

export interface HeartbeatTradingClient extends TradingClient {
  /** Send and confirm the first heartbeat before scheduling subsequent ones. */
  startHeartbeat(intervalMs?: number): Promise<void>;
  stopHeartbeat(): void;
}
