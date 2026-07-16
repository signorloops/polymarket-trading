import { createPublicClient, http, type Address } from 'viem';
import { polygon } from 'viem/chains';

export const POLYMARKET_PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as const;
export const POLYMARKET_CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;

const BALANCE_OF_ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const BALANCE_OF_ERC1155_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface OnchainReadPort {
  getChainId(): Promise<number>;
  readContract(parameters: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

export interface OnchainBalanceSnapshot {
  chainId: 137;
  walletAddress: Address;
  collateralAtomic: string;
  tokenBalances: { tokenId: string; atomic: string }[];
}

/** Read-only Polygon pUSD ERC-20 and CTF ERC-1155 balance snapshot. */
export class OnchainBalanceReader {
  private readonly client: OnchainReadPort;

  constructor(rpcUrl: string, client?: OnchainReadPort) {
    validateRpcUrl(rpcUrl);
    this.client =
      client ??
      (createPublicClient({
        chain: polygon,
        transport: http(rpcUrl),
      }) as unknown as OnchainReadPort);
  }

  async read(walletAddress: string, tokenIds: readonly string[]): Promise<OnchainBalanceSnapshot> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      throw new Error('A valid Polygon wallet address is required for onchain reconciliation');
    }
    const uniqueTokenIds = [...new Set(tokenIds)];
    if (uniqueTokenIds.length === 0 || uniqueTokenIds.some((tokenId) => !/^\d+$/.test(tokenId))) {
      throw new Error('Numeric CLOB token ids are required for onchain reconciliation');
    }
    const chainId = await this.client.getChainId();
    if (chainId !== 137) {
      throw new Error(`Onchain reconciliation RPC returned chain ${String(chainId)}, expected 137`);
    }
    const address = walletAddress as Address;
    const [collateral, ...tokens] = await Promise.all([
      this.client.readContract({
        address: POLYMARKET_PUSD_ADDRESS,
        abi: BALANCE_OF_ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
      }),
      ...uniqueTokenIds.map((tokenId) =>
        this.client.readContract({
          address: POLYMARKET_CTF_ADDRESS,
          abi: BALANCE_OF_ERC1155_ABI,
          functionName: 'balanceOf',
          args: [address, BigInt(tokenId)],
        })
      ),
    ]);
    return {
      chainId: 137,
      walletAddress: address,
      collateralAtomic: bigintResult(collateral, 'pUSD balance').toString(),
      tokenBalances: uniqueTokenIds.map((tokenId, index) => ({
        tokenId,
        atomic: bigintResult(tokens[index], `token ${tokenId} balance`).toString(),
      })),
    };
  }
}

function validateRpcUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error('POLYGON_RPC_URL must be a valid URL', { cause: error });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('POLYGON_RPC_URL must use HTTPS or HTTP');
  }
}

function bigintResult(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new Error(`Onchain ${field} response is invalid`);
  }
  return value;
}
