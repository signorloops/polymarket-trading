import {
  Chain,
  ClobClient,
  AssetType,
  CONDITIONAL_TOKEN_DECIMALS,
  COLLATERAL_TOKEN_DECIMALS,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type OpenOrder,
  type TickSize,
} from '@polymarket/clob-client-v2';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG, WALLET_CONFIG } from '../utils/config.js';
import type { OrderRequest, OrderResponse } from './polymarket-client.js';
import type {
  HeartbeatTradingClient,
  TradingBalance,
  TradingBalanceClient,
  TradingCollateralBalance,
} from './trading-client.js';
import {
  FileOrderIdempotencyStore,
  type OrderIdempotencyPort,
} from '../execution/order-idempotency-store.js';

export interface SignedClobClientConfig {
  host: string;
  chainId: Chain;
  privateKey?: string;
  apiKey?: string;
  secret?: string;
  passphrase?: string;
  signatureType: SignatureTypeV2;
  funderAddress?: string;
  defaultTickSize?: TickSize;
  negRisk?: boolean;
  idempotencyDirectory?: string;
  deferExec: boolean;
}

export interface SignedClobSdkClient {
  createAndPostOrder(
    userOrder: { tokenID: string; price: number; side: Side; size: number },
    options?: { tickSize?: TickSize; negRisk?: boolean },
    orderType?: OrderType.GTC,
    postOnly?: boolean,
    deferExec?: boolean
  ): Promise<unknown>;
  createAndPostMarketOrder(
    userOrder: {
      tokenID: string;
      price?: number;
      side: Side;
      amount: number;
      orderType?: OrderType.FOK | OrderType.FAK;
    },
    options?: { tickSize?: TickSize; negRisk?: boolean },
    orderType?: OrderType.FOK | OrderType.FAK,
    deferExec?: boolean
  ): Promise<unknown>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  getBalanceAllowance(params: {
    asset_type: AssetType;
    token_id?: string;
  }): Promise<BalanceAllowanceResponse>;
  postHeartbeat(heartbeatId?: string): Promise<{ heartbeat_id: string; error_msg?: string }>;
}

interface ClobOrderPostResponse {
  success?: boolean;
  orderID?: string;
  id?: string;
  status?: string;
  errorMsg?: string;
  takingAmount?: string;
  makingAmount?: string;
}

interface ClobCancelResponse {
  canceled?: string[];
  not_canceled?: Record<string, string>;
}

const HEX_PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

export function getSignedClobConfigFromEnv(): SignedClobClientConfig {
  return {
    host: 'https://clob.polymarket.com',
    chainId: NETWORK_CONFIG.POLYMARKET_CHAIN_ID,
    ...(WALLET_CONFIG.PRIVATE_KEY
      ? { privateKey: normalizePrivateKey(WALLET_CONFIG.PRIVATE_KEY) }
      : {}),
    ...(NETWORK_CONFIG.POLYMARKET_API_KEY ? { apiKey: NETWORK_CONFIG.POLYMARKET_API_KEY } : {}),
    ...(NETWORK_CONFIG.POLYMARKET_SECRET ? { secret: NETWORK_CONFIG.POLYMARKET_SECRET } : {}),
    ...(NETWORK_CONFIG.POLYMARKET_PASSPHRASE
      ? { passphrase: NETWORK_CONFIG.POLYMARKET_PASSPHRASE }
      : {}),
    signatureType: NETWORK_CONFIG.POLYMARKET_SIGNATURE_TYPE,
    ...(NETWORK_CONFIG.POLYMARKET_FUNDER_ADDRESS
      ? { funderAddress: NETWORK_CONFIG.POLYMARKET_FUNDER_ADDRESS }
      : {}),
    ...(NETWORK_CONFIG.POLYMARKET_DEFAULT_TICK_SIZE
      ? { defaultTickSize: NETWORK_CONFIG.POLYMARKET_DEFAULT_TICK_SIZE }
      : {}),
    ...(NETWORK_CONFIG.POLYMARKET_NEG_RISK !== undefined
      ? { negRisk: NETWORK_CONFIG.POLYMARKET_NEG_RISK }
      : {}),
    ...(process.env.ORDER_IDEMPOTENCY_DIR?.trim()
      ? { idempotencyDirectory: process.env.ORDER_IDEMPOTENCY_DIR.trim() }
      : {}),
    deferExec: false,
  };
}

export function createSignedClobTradingClientFromEnv(): SignedClobTradingClient {
  return new SignedClobTradingClient(getSignedClobConfigFromEnv());
}

export class SignedClobTradingClient implements TradingBalanceClient, HeartbeatTradingClient {
  private readonly logger = getLogger().child({ module: 'SignedClobTradingClient' });
  private readonly sdkClient: SignedClobSdkClient;
  private readonly usesInjectedSdk: boolean;
  private readonly idempotencyStore: OrderIdempotencyPort;
  /**
   * Logical orders (tokenID|side|price|size) currently awaiting a response. Each
   * createAndPostOrder call mints a NEW signed order (new salt), so a blind retry
   * while the first is still in flight would place a duplicate real-money order.
   * The SDK exposes no client-order-id/idempotency key, so we guard at the wrapper:
   * refuse an identical concurrent resubmit and require the caller to reconcile via
   * getOrder before resubmitting. (Sequential retry after settle still needs
   * reconciliation — see audit.)
   */
  private readonly inflightOrders: Set<string> = new Set();
  private startupReconciliation: Promise<void> | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatId = '';
  private heartbeatRequest: Promise<void> | undefined;
  private heartbeatGeneration = 0;

  constructor(
    private readonly config: SignedClobClientConfig,
    sdkClient?: SignedClobSdkClient,
    idempotencyStore?: OrderIdempotencyPort
  ) {
    this.usesInjectedSdk = sdkClient !== undefined;
    this.sdkClient = sdkClient ?? this.createSdkClient();
    this.idempotencyStore =
      idempotencyStore ?? new FileOrderIdempotencyStore(config.idempotencyDirectory);
  }

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    this.assertAuthenticated();
    this.assertSupportedOrder(order);
    await this.ensureStartupJournalSafe();

    const orderKey = `${order.marketId}|${order.side}|${String(order.price)}|${String(order.size)}`;
    if (this.inflightOrders.has(orderKey)) {
      this.logger.error('Blocked duplicate in-flight order submission', { orderKey });
      throw new Error(
        `Duplicate in-flight order blocked (key=${orderKey}): an identical order is already pending. ` +
          'Reconcile via getOrder before resubmitting to avoid a duplicate real-money order.'
      );
    }
    const idempotencyKey = order.idempotencyKey;
    if (!idempotencyKey) {
      throw new Error('Signed CLOB orders require an idempotencyKey');
    }
    this.idempotencyStore.claim(idempotencyKey, order);
    this.inflightOrders.add(orderKey);

    try {
      this.logger.info('Submitting signed CLOB order', {
        tokenID: order.marketId,
        side: order.side,
        size: order.size,
        price: order.price,
        orderKey,
      });

      const side = order.side === 'buy' ? Side.BUY : Side.SELL;
      const response =
        order.orderType === 'market'
          ? await this.sdkClient.createAndPostMarketOrder(
              {
                tokenID: order.marketId,
                price: order.price,
                side,
                amount: order.side === 'buy' ? order.size * order.price : order.size,
                orderType: this.toMarketOrderType(order.timeInForce),
              },
              this.buildCreateOrderOptions(),
              this.toMarketOrderType(order.timeInForce),
              this.config.deferExec
            )
          : await this.sdkClient.createAndPostOrder(
              {
                tokenID: order.marketId,
                price: order.price,
                side,
                size: order.size,
              },
              this.buildCreateOrderOptions(),
              OrderType.GTC,
              false,
              this.config.deferExec
            );

      const mapped = this.mapOrderResponse(order, response);
      this.idempotencyStore.markSubmitted(idempotencyKey, mapped.id);
      try {
        const reconciled = await this.getOrder(mapped.id);
        this.recordTerminalOrder(idempotencyKey, reconciled);
        return reconciled;
      } catch (error) {
        this.logger.warn('Posted order could not yet be reconciled; returning conservative state', {
          orderId: mapped.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.recordTerminalOrder(idempotencyKey, mapped);
        return mapped;
      }
    } catch (error) {
      this.idempotencyStore.markUnknown(idempotencyKey, error);
      throw error;
    } finally {
      this.inflightOrders.delete(orderKey);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    this.assertAuthenticated();
    if (orderId.trim() === '') {
      throw new Error('orderId is required for signed CLOB cancellation');
    }

    this.logger.info('Cancelling signed CLOB order', { orderId });
    const response = (await this.sdkClient.cancelOrder({ orderID: orderId })) as ClobCancelResponse;
    if (response.canceled?.includes(orderId)) {
      return;
    }
    const reason = response.not_canceled?.[orderId] ?? 'exchange did not confirm cancellation';
    throw new Error(`CLOB cancellation was not confirmed for ${orderId}: ${reason}`);
  }

  async getOrder(orderId: string): Promise<OrderResponse> {
    this.assertAuthenticated();
    if (orderId.trim() === '') {
      throw new Error('orderId is required for signed CLOB order lookup');
    }

    const response = (await this.sdkClient.getOrder(orderId)) as Partial<OpenOrder>;
    if (response.id && response.id !== orderId) {
      throw new Error(`Signed CLOB order lookup returned mismatched id ${response.id}`);
    }
    const size = parsePositiveDecimal(response.original_size, 'original_size');
    const filledSize = parseNonNegativeDecimal(response.size_matched, 'size_matched');
    const price = parsePositiveDecimal(response.price, 'price');
    if (price >= 1 || filledSize > size + 1e-8) {
      throw new Error('Signed CLOB order response contains inconsistent size or price values');
    }
    const marketId = response.asset_id ?? '';
    if (!/^\d+$/.test(marketId)) {
      throw new Error('Signed CLOB order response has an invalid token id');
    }
    const status = mapClobStatus(response.status, filledSize, size);
    const observedAt = new Date().toISOString();

    return {
      id: response.id ?? orderId,
      marketId,
      side: mapClobSide(response.side),
      size,
      price,
      status,
      filledSize,
      remainingSize: Math.max(size - filledSize, 0),
      createdAt: formatClobTimestamp(response.created_at) ?? observedAt,
      updatedAt: observedAt,
    };
  }

  async getBalances(assetIds: readonly string[]): Promise<TradingBalance[]> {
    this.assertAuthenticated();
    const uniqueAssetIds = [...new Set(assetIds)];
    return mapWithConcurrency(uniqueAssetIds, 5, async (assetId) => {
      if (!/^\d+$/.test(assetId)) {
        throw new Error(`Invalid conditional token id for reconciliation: ${assetId}`);
      }
      const response = await this.sdkClient.getBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: assetId,
      });
      return {
        assetId,
        size: parseAtomicBalance(
          response.balance,
          CONDITIONAL_TOKEN_DECIMALS,
          `conditional token ${assetId}`
        ),
        allowances: Object.fromEntries(
          Object.entries(response.allowances).map(([spender, allowance]) => [
            spender,
            parseAtomicBalance(
              allowance,
              CONDITIONAL_TOKEN_DECIMALS,
              `conditional allowance ${assetId}:${spender}`
            ),
          ])
        ),
      };
    });
  }

  async getCollateralBalance(): Promise<TradingCollateralBalance> {
    this.assertAuthenticated();
    const response = await this.sdkClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    return {
      size: parseAtomicBalance(response.balance, COLLATERAL_TOKEN_DECIMALS, 'pUSD collateral'),
      allowances: Object.fromEntries(
        Object.entries(response.allowances).map(([spender, allowance]) => [
          spender,
          parseAtomicBalance(allowance, COLLATERAL_TOKEN_DECIMALS, `allowance ${spender}`),
        ])
      ),
    };
  }

  async startHeartbeat(intervalMs = 5000): Promise<void> {
    this.assertAuthenticated();
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      throw new Error('Heartbeat interval must be at least 1000ms');
    }
    if (this.heartbeatTimer) return;
    const generation = ++this.heartbeatGeneration;

    const send = (): Promise<void> => {
      if (this.heartbeatRequest) return this.heartbeatRequest;
      const request = (async (): Promise<void> => {
        const response = await this.sdkClient.postHeartbeat(this.heartbeatId);
        if (response.error_msg) {
          throw new Error(response.error_msg);
        }
        if (!response.heartbeat_id) {
          throw new Error('CLOB heartbeat response did not include a heartbeat id');
        }
        this.heartbeatId = response.heartbeat_id;
      })();
      this.heartbeatRequest = request;
      const clearRequest = (): void => {
        if (this.heartbeatRequest === request) this.heartbeatRequest = undefined;
      };
      void request.then(clearRequest, clearRequest);
      return request;
    };

    // The canary awaits this first round trip as a pre-submit health gate.
    await send();
    if (generation !== this.heartbeatGeneration) return;
    this.heartbeatTimer = setInterval(() => {
      void send().catch((error: unknown) => {
        this.logger.error('CLOB heartbeat failed; exchange may cancel open orders', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, intervalMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    this.heartbeatGeneration++;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.heartbeatId = '';
  }

  private async ensureStartupJournalSafe(): Promise<void> {
    this.startupReconciliation ??= this.reconcileStartupJournal();
    return this.startupReconciliation;
  }

  private async reconcileStartupJournal(): Promise<void> {
    const records = this.idempotencyStore.listUnresolved?.() ?? [];
    const ambiguous = records.filter(
      (record) => record.state === 'claimed' || record.state === 'unknown'
    );
    if (ambiguous.length > 0) {
      throw new Error(
        `Order journal contains ${String(ambiguous.length)} ambiguous pre-restart submission(s); reconcile them manually before trading`
      );
    }

    for (const record of records) {
      if (record.state !== 'submitted' || !record.exchangeOrderId) continue;
      const order = await this.getOrder(record.exchangeOrderId);
      if (order.status === 'open' || order.status === 'partial') {
        throw new Error(
          `Pre-restart order ${record.exchangeOrderId} is still ${order.status}; cancel or settle it before new trading`
        );
      }
      this.recordTerminalOrder(record.key, order);
    }
  }

  private recordTerminalOrder(idempotencyKey: string, order: OrderResponse): void {
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      this.idempotencyStore.markTerminal?.(idempotencyKey, order.status);
    }
  }

  private createSdkClient(): SignedClobSdkClient {
    const privateKey = this.config.privateKey;
    if (!privateKey) {
      throw new Error('PRIVATE_KEY is required to create a signed CLOB client');
    }

    const normalizedPrivateKey = normalizePrivateKey(privateKey);
    const account = privateKeyToAccount(normalizedPrivateKey as Hex);
    const signer = createWalletClient({
      account,
      chain: this.config.chainId === Chain.AMOY ? polygonAmoy : polygon,
      transport: http(),
    });

    const creds = this.getApiCreds();
    return new ClobClient({
      host: this.config.host,
      chain: this.config.chainId,
      signer,
      ...(creds ? { creds } : {}),
      signatureType: this.config.signatureType,
      ...(this.config.funderAddress ? { funderAddress: this.config.funderAddress } : {}),
      // A transient POST failure is an ambiguous real-money outcome. The SDK's
      // retry would resend automatically before our durable journal can be
      // reconciled, so fail closed and leave the logical key unresolved instead.
      retryOnError: false,
      throwOnError: true,
    }) as SignedClobSdkClient;
  }

  private assertAuthenticated(): void {
    const missing: string[] = [];
    if (!this.usesInjectedSdk && !this.config.privateKey) {
      missing.push('PRIVATE_KEY');
    }
    if (!this.config.apiKey) {
      missing.push('POLYMARKET_API_KEY');
    }
    if (!this.config.secret) {
      missing.push('POLYMARKET_SECRET');
    }
    if (!this.config.passphrase) {
      missing.push('POLYMARKET_PASSPHRASE');
    }
    if (
      (this.config.signatureType === SignatureTypeV2.POLY_PROXY ||
        this.config.signatureType === SignatureTypeV2.POLY_GNOSIS_SAFE ||
        this.config.signatureType === SignatureTypeV2.POLY_1271) &&
      !this.config.funderAddress
    ) {
      missing.push('POLYMARKET_FUNDER_ADDRESS');
    }

    if (missing.length > 0) {
      throw new Error(`Signed CLOB trading is not configured: missing ${missing.join(', ')}`);
    }
  }

  private assertSupportedOrder(order: OrderRequest): void {
    if (!Number.isFinite(order.size) || order.size <= 0) {
      throw new Error('Signed CLOB order size must be greater than 0');
    }
    if (!Number.isFinite(order.price) || order.price <= 0 || order.price >= 1) {
      throw new Error('Signed CLOB limit order price must be between 0 and 1');
    }
    if (order.orderType === 'market') {
      if (
        order.timeInForce !== undefined &&
        order.timeInForce !== 'FOK' &&
        order.timeInForce !== 'FAK' &&
        order.timeInForce !== 'IOC'
      ) {
        throw new Error('Signed CLOB market orders require FOK or FAK time-in-force');
      }
      return;
    }
    if (order.timeInForce !== undefined && order.timeInForce !== 'GTC') {
      throw new Error('Signed CLOB adapter currently supports only GTC limit orders');
    }
  }

  private buildCreateOrderOptions(): { tickSize?: TickSize; negRisk?: boolean } {
    return {
      ...(this.config.defaultTickSize ? { tickSize: this.config.defaultTickSize } : {}),
      ...(this.config.negRisk !== undefined ? { negRisk: this.config.negRisk } : {}),
    };
  }

  private getApiCreds(): ApiKeyCreds | undefined {
    if (!this.config.apiKey || !this.config.secret || !this.config.passphrase) {
      return undefined;
    }

    return {
      key: this.config.apiKey,
      secret: this.config.secret,
      passphrase: this.config.passphrase,
    };
  }

  private toMarketOrderType(
    timeInForce: OrderRequest['timeInForce']
  ): OrderType.FOK | OrderType.FAK {
    return timeInForce === 'FAK' || timeInForce === 'IOC' ? OrderType.FAK : OrderType.FOK;
  }

  private mapOrderResponse(order: OrderRequest, response: unknown): OrderResponse {
    const body = response as ClobOrderPostResponse;
    if (body.success === false || body.errorMsg) {
      throw new Error(body.errorMsg ?? 'Signed CLOB order was rejected');
    }

    const orderId = body.orderID ?? body.id;
    if (!orderId) {
      throw new Error('Signed CLOB order response did not include an order id');
    }

    const rawFilledSize =
      order.side === 'buy'
        ? parseOptionalNonNegativeDecimal(body.takingAmount)
        : parseOptionalNonNegativeDecimal(body.makingAmount);
    const filledSize = Math.min(rawFilledSize, order.size);
    const status = mapClobStatus(body.status, filledSize, order.size);

    return {
      id: orderId,
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
      status,
      filledSize,
      remainingSize: Math.max(order.size - filledSize, 0),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!HEX_PRIVATE_KEY_REGEX.test(normalized)) {
    throw new Error('PRIVATE_KEY must be a 32-byte hex string');
  }
  return normalized;
}

function mapClobStatus(
  status: string | undefined,
  filledSize: number,
  requestedSize: number
): OrderResponse['status'] {
  const normalized = status?.toLowerCase().replace(/^order_status_/, '');
  if (filledSize >= requestedSize - 1e-8) {
    return 'filled';
  }
  switch (normalized) {
    case 'partial':
    case 'partially_filled':
      return 'partial';
    case 'filled':
    case 'matched':
      return filledSize > 0 ? 'partial' : 'open';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'rejected':
    case 'failed':
    case 'invalid':
      return 'rejected';
    case 'live':
    case 'open':
    case 'unmatched':
    case 'delayed':
    case undefined:
      return filledSize > 0 ? 'partial' : 'open';
    default:
      throw new Error(`Signed CLOB order response has an unknown status: ${status ?? 'missing'}`);
  }
}

function mapClobSide(side?: string): OrderResponse['side'] {
  switch (side?.toLowerCase()) {
    case 'buy':
      return 'buy';
    case 'sell':
      return 'sell';
    default:
      throw new Error(`Signed CLOB order response has an invalid side: ${side ?? 'missing'}`);
  }
}

function formatClobTimestamp(value?: number | string): string | undefined {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return undefined;
  }

  const milliseconds = numericValue < 1_000_000_000_000 ? numericValue * 1_000 : numericValue;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAtomicBalance(rawBalance: string, decimals: number, label: string): number {
  if (!/^\d+$/.test(rawBalance)) {
    throw new Error(`CLOB returned an invalid balance for ${label}`);
  }
  const atomicUnits = Number(rawBalance);
  if (!Number.isSafeInteger(atomicUnits)) {
    throw new Error(`CLOB balance for ${label} exceeds safe numeric precision`);
  }
  return atomicUnits / 10 ** decimals;
}

function parsePositiveDecimal(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Signed CLOB order response has an invalid ${field}`);
  }
  return parsed;
}

function parseNonNegativeDecimal(value: string | undefined, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Signed CLOB order response has an invalid ${field}`);
  }
  return parsed;
}

function parseOptionalNonNegativeDecimal(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  return parseNonNegativeDecimal(value, 'fill amount');
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        const value = values[index];
        if (value !== undefined) {
          results[index] = await mapper(value);
        }
      }
    })
  );
  return results;
}
