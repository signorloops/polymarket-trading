/**
 * Type definitions for the execution engine
 *
 * Centralizes all interfaces and types used in trade execution.
 */

/**
 * Trade order definition
 */
export interface TradeOrder {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'FAK';
}

/**
 * Order status tracking
 */
export interface OrderStatus {
  orderId: string;
  exchangeOrderId?: string;
  status: 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'error';
  filledSize: number;
  remainingSize: number;
  /**
   * Approximate average fill price. The CLOB open-order payload exposes the
   * limit (or 0 for market orders), not trade VWAP — so buys may overstate
   * cost and sells may understate proceeds until a trade-ledger VWAP is wired
   * (EXEC-7). Callers must treat this as an upper/lower bound, not exact PnL.
   */
  avgPrice: number;
  timestamp: number;
  error?: string;
}

/**
 * Multi-order execution result
 */
export interface ExecutionResult {
  success: boolean;
  orders: OrderStatus[];
  totalFilled: number;
  totalCost: number;
  errors: string[];
  executionTime: number;
  recovery?: ExecutionRecoveryResult;
}

export interface ExecutionRecoveryResult {
  attempted: boolean;
  cancellationsConfirmed: boolean;
  unwindAttempted: boolean;
  unwindComplete: boolean;
  manualInterventionRequired: boolean;
  cancelledOrderIds: string[];
  unwindOrders: OrderStatus[];
  errors: string[];
}

/**
 * Single leg of an arbitrage trade
 */
export interface TradeLeg {
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  expectedPrice: number;
}
