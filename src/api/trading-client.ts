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
}

export interface TradingBalanceClient extends TradingStatusClient {
  getBalances(assetIds: readonly string[]): Promise<TradingBalance[]>;
}
