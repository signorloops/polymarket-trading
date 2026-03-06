/**
 * Tests for TransactionPersistence — crash recovery state management.
 */

import { jest } from '@jest/globals';

// Mock fs and logger before importing the module under test
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockRenameSync = jest.fn();

jest.unstable_mockModule('node:fs', () => ({
  default: {
    writeFileSync: mockWriteFileSync,
    readFileSync: mockReadFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    renameSync: mockRenameSync,
  },
}));

jest.unstable_mockModule('../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { TransactionPersistence } = await import('../../src/blockchain/transaction-persistence.js');
import type { Transaction } from '../../src/blockchain/transaction-persistence.js';

function makeValidTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    hash: 'tx-hash-1',
    orderId: 'order-1',
    marketId: 'market-1',
    status: 'confirmed',
    createdAt: Date.now(),
    confirmations: 5,
    retryCount: 0,
    ...overrides,
  };
}

describe('TransactionPersistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('enabled', () => {
    it('should return true for non-empty path', () => {
      const p = new TransactionPersistence('/tmp/state.json');
      expect(p.enabled).toBe(true);
    });

    it('should return false for empty string path', () => {
      const p = new TransactionPersistence('');
      expect(p.enabled).toBe(false);
    });
  });

  describe('saveState', () => {
    it('should skip when path is empty', () => {
      const p = new TransactionPersistence('');
      p.saveState([makeValidTx()]);
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('should create directory, write temp file, and rename', () => {
      const p = new TransactionPersistence('/data/.state/tracker.json');
      const tx = makeValidTx();

      p.saveState([tx]);

      expect(mockMkdirSync).toHaveBeenCalledWith('/data/.state', { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/data/.state/tracker.json.tmp',
        expect.any(String),
        'utf8'
      );
      expect(mockRenameSync).toHaveBeenCalledWith(
        '/data/.state/tracker.json.tmp',
        '/data/.state/tracker.json'
      );
    });

    it('should log error but not throw when fs fails', () => {
      mockMkdirSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      const p = new TransactionPersistence('/data/.state/tracker.json');
      expect(() => p.saveState([makeValidTx()])).not.toThrow();
    });
  });

  describe('loadState', () => {
    it('should return empty array when path is empty', () => {
      const p = new TransactionPersistence('');
      expect(p.loadState()).toEqual([]);
    });

    it('should return empty array when file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toEqual([]);
    });

    it('should return empty array when file is empty', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('   ');
      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toEqual([]);
    });

    it('should parse valid PersistedState format', () => {
      const tx = makeValidTx();
      const state = { transactions: [tx], savedAt: Date.now() };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(state));

      const p = new TransactionPersistence('/data/state.json');
      const result = p.loadState();

      expect(result).toHaveLength(1);
      expect(result[0]!.hash).toBe('tx-hash-1');
    });

    it('should parse legacy array format', () => {
      const tx = makeValidTx();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([tx]));

      const p = new TransactionPersistence('/data/state.json');
      const result = p.loadState();

      expect(result).toHaveLength(1);
    });

    it('should filter out invalid transactions', () => {
      const validTx = makeValidTx();
      const invalidTx = { hash: 'only-hash' }; // missing required fields
      const state = { transactions: [validTx, invalidTx], savedAt: Date.now() };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(state));

      const p = new TransactionPersistence('/data/state.json');
      const result = p.loadState();

      expect(result).toHaveLength(1);
      expect(result[0]!.hash).toBe('tx-hash-1');
    });

    it('should return empty array on JSON parse failure', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{invalid json');

      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toEqual([]);
    });

    it('should return empty array for non-object/non-array parsed value', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('"just a string"');

      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toEqual([]);
    });
  });

  describe('isValidTransaction (via loadState)', () => {
    it('should accept valid transaction with all required fields', () => {
      const tx = makeValidTx();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([tx]));

      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toHaveLength(1);
    });

    it.each(['hash', 'orderId', 'marketId', 'status', 'createdAt'] as const)(
      'should reject transaction missing %s',
      (field) => {
        const tx = makeValidTx();
        const { [field]: _removed, ...rest } = tx as Record<string, unknown>;
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify([rest]));

        const p = new TransactionPersistence('/data/state.json');
        expect(p.loadState()).toHaveLength(0);
      }
    );

    it('should reject null value', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([null]));

      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toHaveLength(0);
    });

    it('should reject transaction with invalid status string', () => {
      const tx = makeValidTx({ status: 'bogus' as 'pending' });
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([tx]));

      const p = new TransactionPersistence('/data/state.json');
      expect(p.loadState()).toHaveLength(0);
    });

    it.each(['pending', 'submitted', 'confirmed', 'finalized', 'failed', 'expired'] as const)(
      'should accept valid status "%s"',
      (status) => {
        const tx = makeValidTx({ status });
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify([tx]));

        const p = new TransactionPersistence('/data/state.json');
        expect(p.loadState()).toHaveLength(1);
      }
    );
  });
});
