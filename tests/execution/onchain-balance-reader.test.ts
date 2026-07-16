import { jest } from '@jest/globals';

import {
  OnchainBalanceReader,
  POLYMARKET_CTF_ADDRESS,
  POLYMARKET_PUSD_ADDRESS,
  type OnchainReadPort,
} from '../../src/execution/onchain-balance-reader.js';

describe('OnchainBalanceReader', () => {
  const wallet = '0x1111111111111111111111111111111111111111';

  it('reads pUSD and CTF token balances from the official V2 contracts', async () => {
    const readContract = jest
      .fn<OnchainReadPort['readContract']>()
      .mockResolvedValueOnce(1_250_000n)
      .mockResolvedValueOnce(2_000_000n)
      .mockResolvedValueOnce(3_000_000n);
    const client: OnchainReadPort = {
      getChainId: jest.fn().mockResolvedValue(137),
      readContract,
    };

    const snapshot = await new OnchainBalanceReader('https://polygon.example.com', client).read(
      wallet,
      ['123', '456', '123']
    );

    expect(snapshot).toEqual({
      chainId: 137,
      walletAddress: wallet,
      collateralAtomic: '1250000',
      tokenBalances: [
        { tokenId: '123', atomic: '2000000' },
        { tokenId: '456', atomic: '3000000' },
      ],
    });
    expect(readContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ address: POLYMARKET_PUSD_ADDRESS, functionName: 'balanceOf' })
    );
    expect(readContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ address: POLYMARKET_CTF_ADDRESS, args: [wallet, 123n] })
    );
  });

  it('fails closed when the RPC is connected to the wrong chain', async () => {
    const client: OnchainReadPort = {
      getChainId: jest.fn().mockResolvedValue(80002),
      readContract: jest.fn(),
    };

    await expect(
      new OnchainBalanceReader('https://polygon.example.com', client).read(wallet, ['123'])
    ).rejects.toThrow(/expected 137/);
    expect(client.readContract).not.toHaveBeenCalled();
  });
});
