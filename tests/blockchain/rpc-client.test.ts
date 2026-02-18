/**
 * RPC Client Unit Tests
 *
 * Tests for the blockchain RPC client using mocked fetch.
 */

import { jest } from '@jest/globals';
import {
  RpcClient,
  NETWORKS,
  type TransactionReceipt,
  type Block,
} from '../../src/blockchain/rpc-client.js';

describe('RpcClient', () => {
  let mockFetch: jest.MockedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = jest.fn<typeof fetch>();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create client with provided config', () => {
      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        network: 'mumbai',
        chainId: 80001,
        confirmationBlocks: 5,
        finalizationBlocks: 32,
      });

      expect(client.getChainId()).toBe(80001);
      expect(client.getNetworkConfig().network).toBe('mumbai');
    });
  });

  describe('getBlockNumber', () => {
    it('should return block number as integer', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: '0x2a',
        }),
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const blockNumber = await client.getBlockNumber();
      expect(blockNumber).toBe(42);
    });

    it('should throw on RPC error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      await expect(client.getBlockNumber()).rejects.toThrow('RPC request failed');
    });
  });

  describe('getTransactionReceipt', () => {
    it('should return receipt for valid transaction', async () => {
      const mockReceipt: TransactionReceipt = {
        transactionHash: '0xabc123',
        transactionIndex: '0x0',
        blockHash: '0xdef456',
        blockNumber: '0x2a',
        from: '0xfrom',
        to: '0xto',
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        status: '0x1',
        effectiveGasPrice: '0x1',
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: mockReceipt,
        }),
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const receipt = await client.getTransactionReceipt('0xabc123');
      expect(receipt).toEqual(mockReceipt);
    });

    it('should return null for non-existent transaction', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: null,
        }),
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const receipt = await client.getTransactionReceipt('0xnonexistent');
      expect(receipt).toBeNull();
    });
  });

  describe('isConfirmed', () => {
    it('should return true when confirmations met', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: {
              transactionHash: '0xabc',
              blockNumber: '0x64', // block 100
              status: '0x1',
            } as TransactionReceipt,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: '0x6e', // block 110 (10 confirmations)
          }),
        } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const isConfirmed = await client.isConfirmed('0xabc', 5);
      expect(isConfirmed).toBe(true);
    });

    it('should return false when not enough confirmations', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: {
              transactionHash: '0xabc',
              blockNumber: '0x64', // block 100
              status: '0x1',
            } as TransactionReceipt,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: '0x65', // block 101 (2 confirmations, need 5)
          }),
        } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const isConfirmed = await client.isConfirmed('0xabc', 5);
      expect(isConfirmed).toBe(false);
    });
  });

  describe('getTransactionStatus', () => {
    it('should return finalized for old confirmed transaction', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: {
              transactionHash: '0xabc',
              blockNumber: '0x1', // block 1
              status: '0x1',
              gasUsed: '0x5208',
            } as TransactionReceipt,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: '0x1000', // block 4096 (way more than finalization threshold)
          }),
        } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const status = await client.getTransactionStatus('0xabc');
      expect(status.status).toBe('finalized');
      expect(status.confirmations).toBeGreaterThan(NETWORKS.mumbai.finalizationBlocks);
    });

    it('should return failed for reverted transaction', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: {
              transactionHash: '0xabc',
              blockNumber: '0x64',
              status: '0x0', // Failed
              gasUsed: '0x5208',
            } as TransactionReceipt,
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: '0x64',
          }),
        } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const status = await client.getTransactionStatus('0xabc');
      expect(status.status).toBe('failed');
    });

    it('should return pending for transaction without receipt', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: null, // No receipt yet
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            id: expect.any(Number),
            result: '0x64',
          }),
        } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const status = await client.getTransactionStatus('0xabc');
      expect(status.status).toBe('pending');
      expect(status.confirmations).toBe(0);
    });
  });

  describe('validateNetwork', () => {
    it('should return true when chain ID matches', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: '0x13881', // 80001 in hex
        }),
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const isValid = await client.validateNetwork();
      expect(isValid).toBe(true);
    });

    it('should return false when chain ID does not match', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: '2.0',
          id: expect.any(Number),
          result: '0x1', // Mainnet
        }),
      } as Response);

      const client = new RpcClient({
        rpcUrl: 'https://example.com',
        ...NETWORKS.mumbai,
      });

      const isValid = await client.validateNetwork();
      expect(isValid).toBe(false);
    });
  });

  describe('factory methods', () => {
    it('should create client fromEnv with RPC_URL', () => {
      const originalEnv = process.env.RPC_URL;
      process.env.RPC_URL = 'https://polygon-rpc.com';

      try {
        const client = RpcClient.fromEnv();
        expect(client).not.toBeNull();
      } finally {
        process.env.RPC_URL = originalEnv;
      }
    });

    it('should return null fromEnv without RPC_URL', () => {
      const originalEnv = process.env.RPC_URL;
      delete process.env.RPC_URL;

      try {
        const client = RpcClient.fromEnv();
        expect(client).toBeNull();
      } finally {
        process.env.RPC_URL = originalEnv;
      }
    });
  });
});

describe('NETWORKS', () => {
  it('should have correct Mumbai config', () => {
    expect(NETWORKS.mumbai).toEqual({
      network: 'mumbai',
      chainId: 80001,
      confirmationBlocks: 5,
      finalizationBlocks: 32,
    });
  });

  it('should have correct Mainnet config', () => {
    expect(NETWORKS.mainnet).toEqual({
      network: 'mainnet',
      chainId: 137,
      confirmationBlocks: 12,
      finalizationBlocks: 128,
    });
  });
});
