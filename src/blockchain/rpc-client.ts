/**
 * Blockchain RPC Client
 *
 * Provides low-level blockchain interaction for:
 * - Transaction status queries
 * - Block number retrieval
 * - Receipt parsing
 * - Chain ID verification
 *
 * Supports Polygon mainnet and Mumbai testnet.
 */

import { getLogger } from '../utils/logger.js';
import { getErrorMessage } from '../utils/errors.js';
import { createSingleton } from '../utils/singleton.js';

export type NetworkType = 'mainnet' | 'mumbai';

export interface TransactionReceipt {
  transactionHash: string;
  transactionIndex: string;
  blockHash: string;
  blockNumber: string;
  from: string;
  to: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  contractAddress: string | null;
  logs: unknown[];
  status: string; // '0x1' for success, '0x0' for failure
  effectiveGasPrice: string;
}

export interface Block {
  number: string;
  hash: string;
  timestamp: string;
  transactions: string[];
}

export interface RpcClientConfig {
  rpcUrl: string;
  network: NetworkType;
  chainId: number;
  confirmationBlocks: number;
  finalizationBlocks: number;
}

// Network configurations
export const NETWORKS: Record<NetworkType, Omit<RpcClientConfig, 'rpcUrl'>> = {
  mainnet: {
    network: 'mainnet',
    chainId: 137,
    confirmationBlocks: 12,
    finalizationBlocks: 128,
  },
  mumbai: {
    network: 'mumbai',
    chainId: 80001,
    confirmationBlocks: 5,
    finalizationBlocks: 32,
  },
};

/**
 * RPC Client for blockchain interaction
 */
export class RpcClient {
  private rpcUrl: string;
  private network: NetworkType;
  private chainId: number;
  private confirmationBlocks: number;
  private finalizationBlocks: number;
  private logger = getLogger().child({ module: 'RpcClient' });

  constructor(config: RpcClientConfig) {
    this.rpcUrl = config.rpcUrl;
    this.network = config.network;
    this.chainId = config.chainId;
    this.confirmationBlocks = config.confirmationBlocks;
    this.finalizationBlocks = config.finalizationBlocks;
  }

  /**
   * Create RPC client from environment variables
   */
  static fromEnv(): RpcClient | null {
    const rpcUrl = process.env.RPC_URL;
    if (!rpcUrl) {
      return null;
    }

    // Detect network from URL or env
    const network: NetworkType = process.env.NETWORK === 'mumbai' ? 'mumbai' : 'mainnet';
    const networkConfig = NETWORKS[network];

    return new RpcClient({
      rpcUrl,
      ...networkConfig,
    });
  }

  /**
   * Create Mumbai testnet client
   */
  static createMumbaiClient(rpcUrl?: string): RpcClient | null {
    const url = rpcUrl ?? process.env.MUMBAI_RPC_URL;
    if (!url) {
      return null;
    }

    return new RpcClient({
      rpcUrl: url,
      ...NETWORKS.mumbai,
    });
  }

  /**
   * Make JSON-RPC request
   */
  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`RPC request failed: ${String(response.status)} ${response.statusText}`);
    }

    const data = await response.json() as {
      jsonrpc: string;
      id: number;
      result?: T;
      error?: { code: number; message: string };
    };

    if (data.error) {
      throw new Error(`RPC error: ${data.error.message} (code: ${String(data.error.code)})`);
    }

    return data.result as T;
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    const result = await this.rpcCall<string>('eth_blockNumber', []);
    return parseInt(result, 16);
  }

  /**
   * Get block by number
   */
  async getBlock(blockNumber: number | 'latest' | 'pending'): Promise<Block | null> {
    const blockParam = typeof blockNumber === 'number'
      ? `0x${blockNumber.toString(16)}`
      : blockNumber;

    return this.rpcCall<Block>('eth_getBlockByNumber', [blockParam, false]);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(hash: string): Promise<TransactionReceipt | null> {
    return this.rpcCall<TransactionReceipt>('eth_getTransactionReceipt', [hash]);
  }

  /**
   * Check if transaction is confirmed
   */
  async isConfirmed(hash: string, confirmations?: number): Promise<boolean> {
    const requiredConfirmations = confirmations ?? this.confirmationBlocks;

    const [receipt, currentBlock] = await Promise.all([
      this.getTransactionReceipt(hash),
      this.getBlockNumber(),
    ]);

    if (!receipt) {
      return false;
    }

    const txBlockNumber = parseInt(receipt.blockNumber, 16);
    const actualConfirmations = currentBlock - txBlockNumber + 1;

    return actualConfirmations >= requiredConfirmations;
  }

  /**
   * Check if transaction is finalized
   */
  async isFinalized(hash: string): Promise<boolean> {
    return this.isConfirmed(hash, this.finalizationBlocks);
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(hash: string): Promise<{
    status: 'pending' | 'confirmed' | 'finalized' | 'failed';
    confirmations: number;
    blockNumber?: number;
    receipt?: TransactionReceipt;
  }> {
    const [receipt, currentBlock] = await Promise.all([
      this.getTransactionReceipt(hash),
      this.getBlockNumber(),
    ]);

    if (!receipt) {
      return { status: 'pending', confirmations: 0 };
    }

    const blockNumber = parseInt(receipt.blockNumber, 16);
    const confirmations = currentBlock - blockNumber + 1;

    // Check if transaction failed
    if (receipt.status === '0x0') {
      return {
        status: 'failed',
        confirmations,
        blockNumber,
        receipt,
      };
    }

    // Check finalization
    if (confirmations >= this.finalizationBlocks) {
      return {
        status: 'finalized',
        confirmations,
        blockNumber,
        receipt,
      };
    }

    // Check confirmation
    if (confirmations >= this.confirmationBlocks) {
      return {
        status: 'confirmed',
        confirmations,
        blockNumber,
        receipt,
      };
    }

    // Has receipt but not enough confirmations
    return {
      status: 'pending',
      confirmations,
      blockNumber,
      receipt,
    };
  }

  /**
   * Wait for transaction confirmation
   */
  async waitForConfirmation(
    hash: string,
    confirmations?: number,
    timeoutMs = 300000
  ): Promise<TransactionReceipt> {
    const startTime = Date.now();
    const requiredConfirmations = confirmations ?? this.confirmationBlocks;

    return new Promise((resolve, reject) => {
      const checkStatus = async () => {
        try {
          // Check timeout
          if (Date.now() - startTime > timeoutMs) {
            reject(new Error(`Timeout waiting for confirmation of ${hash}`));
            return;
          }

          const status = await this.getTransactionStatus(hash);

          if (status.status === 'failed') {
            reject(new Error(`Transaction ${hash} failed`));
            return;
          }

          if (status.receipt && status.confirmations >= requiredConfirmations) {
            resolve(status.receipt);
            return;
          }

          // Wait and check again
          const timer = setTimeout(() => {
            void checkStatus();
          }, 2000);
          timer.unref();
        } catch (error: unknown) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      void checkStatus();
    });
  }

  /**
   * Get network configuration
   */
  getNetworkConfig(): RpcClientConfig {
    return {
      rpcUrl: this.rpcUrl,
      network: this.network,
      chainId: this.chainId,
      confirmationBlocks: this.confirmationBlocks,
      finalizationBlocks: this.finalizationBlocks,
    };
  }

  /**
   * Get chain ID
   */
  getChainId(): number {
    return this.chainId;
  }

  /**
   * Check if connected to expected network
   */
  async validateNetwork(): Promise<boolean> {
    try {
      const chainIdHex = await this.rpcCall<string>('eth_chainId', []);
      const chainId = parseInt(chainIdHex, 16);
      return chainId === this.chainId;
    } catch (error) {
      this.logger.error('Failed to validate network', {
        error: getErrorMessage(error),
      });
      return false;
    }
  }
}

// Singleton instance
const rpcClientSingleton = createSingleton<RpcClient | null>(() => RpcClient.fromEnv());

let rpcClientOverride: RpcClient | null = null;

export function getRpcClient(): RpcClient | null {
  return rpcClientOverride ?? rpcClientSingleton.get();
}

export function resetRpcClient(): void {
  rpcClientOverride = null;
  rpcClientSingleton.reset();
}

export function setRpcClient(client: RpcClient): void {
  rpcClientOverride = client;
}
