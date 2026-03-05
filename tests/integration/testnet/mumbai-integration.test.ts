/**
 * Polygon Mumbai Testnet Integration Tests
 *
 * These tests interact with the actual Mumbai testnet.
 * They require:
 * - MUMBAI_RPC_URL environment variable
 * - Test wallet with Mumbai MATIC (faucet: https://faucet.polygon.technology/)
 *
 * Tests are skipped by default to avoid unintended testnet usage.
 * Run with: MUMBAI_RPC_URL=<url> npm test -- --testNamePattern="Mumbai"
 */

import { jest } from '@jest/globals';
import { RpcClient, NETWORKS, type NetworkType } from '../../../src/blockchain/rpc-client.js';
import {
  TransactionTracker,
  resetTransactionTracker,
} from '../../../src/blockchain/transaction-tracker.js';

describe('Mumbai Testnet Integration', () => {
  const mumbaiRpcUrl = process.env.MUMBAI_RPC_URL;
  const hasMumbaiConfig = !!mumbaiRpcUrl;

  // Skip all tests if Mumbai RPC is not configured
  const conditionalTest = hasMumbaiConfig ? it : it.skip;

  beforeEach(() => {
    resetTransactionTracker();
  });

  afterEach(() => {
    resetTransactionTracker();
  });

  describe('RPC Client', () => {
    conditionalTest('should connect to Mumbai testnet', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      const isValid = await client.validateNetwork();
      expect(isValid).toBe(true);
    });

    conditionalTest('should get current block number', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      const blockNumber = await client.getBlockNumber();
      expect(blockNumber).toBeGreaterThan(0);
      expect(blockNumber).toBeGreaterThan(50000000); // Mumbai is well past this
    });

    conditionalTest('should get block details', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      const block = await client.getBlock('latest');
      expect(block).not.toBeNull();
      expect(block?.number).toBeDefined();
      expect(block?.hash).toBeDefined();
      expect(block?.timestamp).toBeDefined();
    });

    conditionalTest('should return null for non-existent transaction', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      const fakeHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const receipt = await client.getTransactionReceipt(fakeHash);

      expect(receipt).toBeNull();
    });
  });

  describe('Transaction Status Tracking', () => {
    conditionalTest('should track pending transaction status', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      const tracker = new TransactionTracker(mumbaiRpcUrl);

      // Use a fake hash to simulate pending transaction
      const fakeHash = '0x' + 'ab'.repeat(32);
      tracker.trackTransaction(fakeHash, 'order-1', 'market-1');

      const tx = tracker.getTransaction(fakeHash);
      expect(tx).toBeDefined();
      expect(tx?.status).toBe('pending');

      tracker.stop();
    });

    conditionalTest('should update transaction status from blockchain', async () => {
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        ...NETWORKS.mumbai,
      });

      // Track a real Mumbai transaction (this is a sample - may not exist)
      // In practice, you'd submit a real transaction first
      const tracker = new TransactionTracker(mumbaiRpcUrl);

      // Example: use a known successful transaction hash from Mumbai
      // You can get one from https://mumbai.polygonscan.com/
      const knownTxHash = process.env.MUMBAI_TEST_TX_HASH;

      if (!knownTxHash) {
        // Skip if no test transaction configured
        return;
      }

      tracker.trackTransaction(knownTxHash, 'order-test', 'market-test');

      // Wait a bit for polling
      await new Promise((resolve) => setTimeout(resolve, 100));

      const tx = tracker.getTransaction(knownTxHash);
      expect(tx).toBeDefined();

      tracker.stop();
    });
  });

  describe('Network Configuration', () => {
    it('should have correct Mumbai network parameters', () => {
      const mumbaiConfig = NETWORKS.mumbai;

      expect(mumbaiConfig.network).toBe('mumbai');
      expect(mumbaiConfig.chainId).toBe(80001);
      expect(mumbaiConfig.confirmationBlocks).toBe(5);
      expect(mumbaiConfig.finalizationBlocks).toBe(32);
    });

    it('should have correct Mainnet network parameters', () => {
      const mainnetConfig = NETWORKS.mainnet;

      expect(mainnetConfig.network).toBe('mainnet');
      expect(mainnetConfig.chainId).toBe(137);
      expect(mainnetConfig.confirmationBlocks).toBe(12);
      expect(mainnetConfig.finalizationBlocks).toBe(128);
    });
  });

  describe('Client Factory Methods', () => {
    it('should create Mumbai client from environment', () => {
      const originalEnv = process.env.MUMBAI_RPC_URL;

      try {
        process.env.MUMBAI_RPC_URL = 'https://rpc-mumbai.maticvigil.com';

        const client = RpcClient.createMumbaiClient();
        expect(client).not.toBeNull();

        const config = client!.getNetworkConfig();
        expect(config.network).toBe('mumbai');
        expect(config.chainId).toBe(80001);
      } finally {
        process.env.MUMBAI_RPC_URL = originalEnv;
      }
    });

    it('should return null when Mumbai RPC URL is not set', () => {
      const originalEnv = process.env.MUMBAI_RPC_URL;

      try {
        delete process.env.MUMBAI_RPC_URL;

        const client = RpcClient.createMumbaiClient();
        expect(client).toBeNull();
      } finally {
        process.env.MUMBAI_RPC_URL = originalEnv;
      }
    });

    it('should accept custom Mumbai RPC URL', () => {
      const customUrl = 'https://custom-mumbai.example.com';
      const client = RpcClient.createMumbaiClient(customUrl);

      expect(client).not.toBeNull();
      expect(client!.getNetworkConfig().rpcUrl).toBe(customUrl);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid RPC URL gracefully', async () => {
      const client = new RpcClient({
        rpcUrl: 'http://localhost:99999', // Invalid port
        ...NETWORKS.mumbai,
      });

      await expect(client.getBlockNumber()).rejects.toThrow();
    });

    conditionalTest('should handle network mismatch', async () => {
      // Create client with wrong chain ID for the connected network
      const client = new RpcClient({
        rpcUrl: mumbaiRpcUrl!,
        network: 'mumbai',
        chainId: 99999, // Wrong chain ID
        confirmationBlocks: 5,
        finalizationBlocks: 32,
      });

      const isValid = await client.validateNetwork();
      expect(isValid).toBe(false);
    });
  });
});

describe('Paper Trading Mode', () => {
  it('should record trades without blockchain submission', () => {
    const tracker = new TransactionTracker();

    // In paper trading, we just track without submitting
    const mockHash = '0x' + '00'.repeat(32);
    const orderId = 'paper-order-1';
    const marketId = 'market-1';

    tracker.trackTransaction(mockHash, orderId, marketId);

    const tx = tracker.getTransaction(mockHash);
    expect(tx).toBeDefined();
    expect(tx?.orderId).toBe(orderId);
    expect(tx?.marketId).toBe(marketId);
    expect(tx?.status).toBe('pending');

    // Simulate confirmation (would normally come from blockchain)
    tracker.updateTransaction({
      hash: mockHash,
      status: 'confirmed',
      blockNumber: 12345,
      confirmations: 5,
    });

    const updatedTx = tracker.getTransaction(mockHash);
    expect(updatedTx?.status).toBe('confirmed');
    expect(updatedTx?.blockNumber).toBe(12345);

    tracker.stop();
  });

  it('should calculate statistics for paper trades', () => {
    const tracker = new TransactionTracker();

    // Track multiple paper trades
    for (let i = 0; i < 5; i++) {
      const hash = `0x${i.toString(16).padStart(64, '0')}`;
      tracker.trackTransaction(hash, `order-${i}`, `market-${i % 2}`);
    }

    const stats = tracker.getStats();
    expect(stats.total).toBe(5);
    expect(stats.pending).toBe(5);

    tracker.stop();
  });
});
