import {
  Chain,
  ClobClient,
  AssetType,
  OrderType,
  Side,
  SignatureType,
  type ApiKeyCreds,
  type BalanceAllowanceResponse,
  type OpenOrder,
  type TickSize,
} from '@polymarket/clob-client';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, polygonAmoy } from 'viem/chains';
import { getLogger } from '../utils/logger.js';
import { NETWORK_CONFIG, WALLET_CONFIG } from '../utils/config.js';
import type { OrderRequest, OrderResponse } from './polymarket-client.js';
import type { TradingBalance, TradingBalanceClient } from './trading-client.js';
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
  signatureType: SignatureType;
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
    deferExec?: boolean,
    postOnly?: boolean
  ): Promise<unknown>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
  getOrder(orderId: string): Promise<unknown>;
  getBalanceAllowance(params: {
    asset_type: AssetType.CONDITIONAL;
    token_id: string;
  }): Promise<BalanceAllowanceResponse>;
}

interface ClobOrderPostResponse {
  success?: boolean;
  orderID?: string;
  id?: string;
  status?: string;
  errorMsg?: string;
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

export class SignedClobTradingClient implements TradingBalanceClient {
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

      const response = await this.sdkClient.createAndPostOrder(
        {
          tokenID: order.marketId,
          price: order.price,
          side: order.side === 'buy' ? Side.BUY : Side.SELL,
          size: order.size,
        },
        this.buildCreateOrderOptions(),
        OrderType.GTC,
        this.config.deferExec,
        false
      );

      const mapped = this.mapOrderResponse(order, response);
      this.idempotencyStore.markSubmitted(idempotencyKey, mapped.id);
      return mapped;
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
    await this.sdkClient.cancelOrder({ orderID: orderId });
  }

  async getOrder(orderId: string): Promise<OrderResponse> {
    this.assertAuthenticated();
    if (orderId.trim() === '') {
      throw new Error('orderId is required for signed CLOB order lookup');
    }

    const response = (await this.sdkClient.getOrder(orderId)) as Partial<OpenOrder>;
    const size = Number(response.original_size ?? '0');
    const filledSize = Number(response.size_matched ?? '0');
    const price = Number(response.price ?? '0');
    const marketId = response.asset_id ?? '';
    const status = mapClobStatus(response.status);
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
    return Promise.all(
      uniqueAssetIds.map(async (assetId) => {
        if (!/^\d+$/.test(assetId)) {
          throw new Error(`Invalid conditional token id for reconciliation: ${assetId}`);
        }
        const response = await this.sdkClient.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: assetId,
        });
        return {
          assetId,
          size: parseConditionalTokenBalance(response.balance, assetId),
        };
      })
    );
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

    return new ClobClient(
      this.config.host,
      this.config.chainId,
      signer,
      this.getApiCreds(),
      this.config.signatureType,
      this.config.funderAddress,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      true
    ) as SignedClobSdkClient;
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
      (this.config.signatureType === SignatureType.POLY_PROXY ||
        this.config.signatureType === SignatureType.POLY_GNOSIS_SAFE) &&
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
      throw new Error(
        'Signed CLOB market orders are not enabled; submit explicit GTC limit orders'
      );
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

  private mapOrderResponse(order: OrderRequest, response: unknown): OrderResponse {
    const body = response as ClobOrderPostResponse;
    if (body.success === false || body.errorMsg) {
      throw new Error(body.errorMsg ?? 'Signed CLOB order was rejected');
    }

    const orderId = body.orderID ?? body.id;
    if (!orderId) {
      throw new Error('Signed CLOB order response did not include an order id');
    }

    const status = mapClobStatus(body.status);
    const filledSize = status === 'filled' ? order.size : 0;

    return {
      id: orderId,
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
      status,
      filledSize,
      remainingSize: order.size - filledSize,
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

function mapClobStatus(status?: string): OrderResponse['status'] {
  switch (status?.toLowerCase()) {
    case 'partial':
    case 'partially_filled':
      return 'partial';
    case 'filled':
    case 'matched':
      return 'filled';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'rejected':
    case 'failed':
      return 'rejected';
    case 'live':
    case 'open':
    case 'unmatched':
    case undefined:
      return 'open';
    default:
      return 'open';
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

function formatClobTimestamp(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseConditionalTokenBalance(rawBalance: string, assetId: string): number {
  if (!/^\d+$/.test(rawBalance)) {
    throw new Error(`CLOB returned an invalid balance for ${assetId}`);
  }
  const atomicUnits = Number(rawBalance);
  if (!Number.isSafeInteger(atomicUnits)) {
    throw new Error(`CLOB balance for ${assetId} exceeds safe numeric precision`);
  }
  return atomicUnits / 1_000_000;
}
