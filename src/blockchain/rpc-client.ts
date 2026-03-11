/**
 * RPC Client for blockchain interaction
 *
 * Supports multiple providers:
 * - Helius (Solana)
 * - Alchemy (Ethereum/Polygon)
 * - Custom JSON-RPC endpoints
 *
 * Features:
 * - Transaction receipt querying
 * - Block number tracking
 * - Confirmation depth checking
 * - Gas price monitoring
 * - Automatic retry with exponential backoff
 */

import { getLogger } from '../utils/logger.js';

export interface TransactionReceipt {
  hash: string;
  blockHash: string;
  blockNumber: number;
  status: 'success' | 'failed' | null;
  gasUsed: string;
  effectiveGasPrice: string;
  cumulativeGasUsed: string;
  logs: LogEntry[];
  confirmations: number;
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface BlockInfo {
  hash: string;
  number: number;
  timestamp: number;
  parentHash: string;
  transactions: string[];
}

export interface GasPriceInfo {
  safeLow: string;
  standard: string;
  fast: string;
  fastest: string;
  blockNumber: number;
  timestamp: number;
}

export interface RpcClientConfig {
  url: string;
  apiKey?: string;
  provider: 'helius' | 'alchemy' | 'custom';
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  chainId?: number;
}

export interface IRpcClient {
  getTransactionReceipt(hash: string): Promise<TransactionReceipt | null>;
  getTransactionStatus(hash: string): Promise<'pending' | 'confirmed' | 'failed' | null>;
  getBlockNumber(): Promise<number>;
  getBlock(blockNumber: number | 'latest' | 'finalized' | 'safe'): Promise<BlockInfo>;
  isConfirmed(hash: string, confirmations: number): Promise<boolean>;
  isFinalized(hash: string): Promise<boolean>;
  getGasPrice(): Promise<GasPriceInfo>;
  healthCheck(): Promise<boolean>;
  destroy(): void;
}

// JSON-RPC request/response types
interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: unknown[];
  id: number;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// Helius specific types
interface HeliusTransactionResponse {
  signature: string;
  slot: number;
  err: null | object;
  confirmationStatus: 'processed' | 'confirmed' | 'finalized';
  blockTime: number | null;
}

// Alchemy specific types
interface AlchemyTransactionReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  cumulativeGasUsed: string;
  logs: AlchemyLog[];
}

interface AlchemyLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

/**
 * RPC Client implementation with retry logic and provider abstraction
 */
export class RpcClient implements IRpcClient {
  private config: RpcClientConfig;
  private logger = getLogger().child({ module: 'RpcClient' });
  private requestId = 0;
  private gasPriceCache: GasPriceInfo | null = null;
  private gasPriceCacheTime = 0;
  private readonly GAS_PRICE_CACHE_TTL_MS = 30000; // 30 seconds
  private lastBlockHash: string | null = null;
  private lastBlockNumber = 0;
  private abortController: AbortController | null = null;

  constructor(config: Partial<RpcClientConfig> & { url: string }) {
    this.config = {
      timeoutMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      provider: 'custom',
      ...config,
    };
    this.abortController = new AbortController();
  }

  /**
   * Make JSON-RPC request with retry logic
   */
  private async makeRequest<T>(method: string, params: unknown[] = []): Promise<T> {
    const url = this.buildUrl();
    const body: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: ++this.requestId,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const requestInit: RequestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        };

        if (this.config.apiKey) {
          (requestInit.headers as Record<string, string>)['X-API-Key'] = this.config.apiKey;
        }

        if (this.abortController?.signal) {
          requestInit.signal = this.abortController.signal;
        }

        const response = await fetch(url, requestInit);

        if (!response.ok) {
          throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`);
        }

        const data = (await response.json()) as JsonRpcResponse<T>;

        if (data.error) {
          throw new Error(`RPC Error ${String(data.error.code)}: ${data.error.message}`);
        }

        if (data.result === undefined) {
          throw new Error('RPC response missing result');
        }

        return data.result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelayMs * Math.pow(2, attempt);
          this.logger.warn(`RPC request failed, retrying`, {
            method,
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            delay,
            error: lastError.message,
          });
          await this.sleep(delay);
        }
      }
    }

    throw lastError ?? new Error('RPC request failed after all retries');
  }

  /**
   * Build request URL with API key if needed
   */
  private buildUrl(): string {
    if (this.config.provider === 'helius' && this.config.apiKey) {
      return `${this.config.url}${this.config.url.includes('?') ? '&' : '?'}api-key=${this.config.apiKey}`;
    }
    return this.config.url;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    try {
      if (this.config.provider === 'helius') {
        return await this.getHeliusTransactionReceipt(hash);
      }

      // Standard Ethereum JSON-RPC
      const result = await this.makeRequest<AlchemyTransactionReceipt | null>(
        'eth_getTransactionReceipt',
        [hash]
      );

      if (!result) return null;

      const currentBlock = await this.getBlockNumber();
      const blockNumber = parseInt(result.blockNumber, 16);

      return {
        hash: result.transactionHash,
        blockHash: result.blockHash,
        blockNumber,
        status: result.status === '0x1' ? 'success' : result.status === '0x0' ? 'failed' : null,
        gasUsed: result.gasUsed,
        effectiveGasPrice: result.effectiveGasPrice,
        cumulativeGasUsed: result.cumulativeGasUsed,
        logs: result.logs.map((log) => ({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: parseInt(log.blockNumber, 16),
          transactionHash: log.transactionHash,
          logIndex: parseInt(log.logIndex, 16),
        })),
        confirmations: currentBlock - blockNumber + 1,
      };
    } catch (error) {
      this.logger.error('Failed to get transaction receipt', {
        hash,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get Helius transaction receipt (Solana)
   */
  private async getHeliusTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    const result = await this.makeRequest<HeliusTransactionResponse | null>(
      'getSignatureStatuses',
      [[hash], { searchTransactionHistory: true }]
    );

    if (!result?.confirmationStatus) return null;

    // Helius returns slot instead of block number
    const slot = result.slot;
    const block = await this.getBlock(slot);

    return {
      hash,
      blockHash: block.hash,
      blockNumber: slot,
      status: result.err ? 'failed' : 'success',
      gasUsed: '0', // Solana doesn't use gas
      effectiveGasPrice: '0',
      cumulativeGasUsed: '0',
      logs: [], // Would need getTransaction to fetch logs
      confirmations: result.confirmationStatus === 'finalized' ? 128 : 1,
    };
  }

  /**
   * Get transaction status (simplified)
   */
  async getTransactionStatus(hash: string): Promise<'pending' | 'confirmed' | 'failed' | null> {
    try {
      const receipt = await this.getTransactionReceipt(hash);
      if (!receipt) return 'pending';
      if (receipt.status === 'failed') return 'failed';
      return 'confirmed';
    } catch {
      return null;
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    const method = this.config.provider === 'helius' ? 'getSlot' : 'eth_blockNumber';

    const result = await this.makeRequest<string | number>(method);
    const blockNumber = typeof result === 'string' ? parseInt(result, 16) : result;

    this.lastBlockNumber = blockNumber;
    return blockNumber;
  }

  /**
   * Get block information
   */
  async getBlock(blockNumber: number | 'latest' | 'finalized' | 'safe'): Promise<BlockInfo> {
    const isHelius = this.config.provider === 'helius';

    if (isHelius && typeof blockNumber === 'number') {
      const result = await this.makeRequest<{
        blockhash: string;
        slot: number;
        blockTime: number | null;
        previousBlockhash: string;
        transactions: unknown[];
      }>('getBlock', [blockNumber, { maxSupportedTransactionVersion: 0 }]);

      this.lastBlockHash = result.blockhash;

      return {
        hash: result.blockhash,
        number: result.slot,
        timestamp: result.blockTime ?? Date.now() / 1000,
        parentHash: result.previousBlockhash,
        transactions: [], // Would need to parse transaction signatures
      };
    }

    // Ethereum JSON-RPC
    const blockParam =
      typeof blockNumber === 'number' ? `0x${blockNumber.toString(16)}` : blockNumber;

    const result = await this.makeRequest<{
      hash: string;
      number: string;
      timestamp: string;
      parentHash: string;
      transactions: string[];
    }>('eth_getBlockByNumber', [blockParam, false]);

    this.lastBlockHash = result.hash;
    this.lastBlockNumber = parseInt(result.number, 16);

    return {
      hash: result.hash,
      number: parseInt(result.number, 16),
      timestamp: parseInt(result.timestamp, 16),
      parentHash: result.parentHash,
      transactions: result.transactions,
    };
  }

  /**
   * Check if transaction has enough confirmations
   */
  async isConfirmed(hash: string, confirmations: number): Promise<boolean> {
    const receipt = await this.getTransactionReceipt(hash);
    if (!receipt) return false;
    return receipt.confirmations >= confirmations;
  }

  /**
   * Check if transaction is finalized
   */
  async isFinalized(hash: string): Promise<boolean> {
    const receipt = await this.getTransactionReceipt(hash);
    if (!receipt) return false;

    // For Ethereum/Polygon, check if we have 128+ confirmations
    if (this.config.provider !== 'helius') {
      return receipt.confirmations >= 128;
    }

    // For Helius, check confirmation status
    const status = await this.makeRequest<({ confirmationStatus: string } | null)[]>(
      'getSignatureStatuses',
      [[hash]]
    );
    return status[0]?.confirmationStatus === 'finalized';
  }

  /**
   * Get current gas price
   */
  async getGasPrice(): Promise<GasPriceInfo> {
    const now = Date.now();

    // Return cached value if still valid
    if (this.gasPriceCache && now - this.gasPriceCacheTime < this.GAS_PRICE_CACHE_TTL_MS) {
      return this.gasPriceCache;
    }

    try {
      if (this.config.provider === 'helius') {
        // Solana uses different fee model
        const result = await this.makeRequest<{
          value: number;
        }>('getRecentPrioritizationFees', [[]]);

        const fee = Math.round(result.value * 1.5); // Add 50% buffer

        this.gasPriceCache = {
          safeLow: fee.toString(),
          standard: (fee * 1.2).toString(),
          fast: (fee * 1.5).toString(),
          fastest: (fee * 2).toString(),
          blockNumber: await this.getBlockNumber(),
          timestamp: now,
        };
      } else {
        // Ethereum JSON-RPC
        const result = await this.makeRequest<string>('eth_gasPrice');
        const basePrice = BigInt(result);

        this.gasPriceCache = {
          safeLow: ((basePrice * 100n) / 100n).toString(),
          standard: ((basePrice * 120n) / 100n).toString(),
          fast: ((basePrice * 150n) / 100n).toString(),
          fastest: ((basePrice * 200n) / 100n).toString(),
          blockNumber: await this.getBlockNumber(),
          timestamp: now,
        };
      }

      this.gasPriceCacheTime = now;
      return this.gasPriceCache;
    } catch (error) {
      this.logger.error('Failed to get gas price', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get last known block info (for reorg detection)
   */
  getLastBlockInfo(): { hash: string | null; number: number } {
    return {
      hash: this.lastBlockHash,
      number: this.lastBlockNumber,
    };
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.gasPriceCache = null;
  }
}

// Singleton instance
let globalRpcClient: RpcClient | null = null;

export function getRpcClient(config?: Partial<RpcClientConfig> & { url: string }): RpcClient {
  if (!globalRpcClient && config) {
    globalRpcClient = new RpcClient(config);
  }
  if (!globalRpcClient) {
    throw new Error('RPC client not initialized. Provide config on first call.');
  }
  return globalRpcClient;
}

export function resetRpcClient(): void {
  globalRpcClient?.destroy();
  globalRpcClient = null;
}
