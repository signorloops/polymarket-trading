import {
  compareThreeWayBalances,
  dynamicFeesAreFresh,
  parseOperatorAuditConfigFromEnv,
  summarizeCanaryEvidence,
} from '../../src/execution/operator-readiness-audit.js';

const wallet = '0x1111111111111111111111111111111111111111';

describe('operator readiness audit', () => {
  it('parses explicit UI evidence into six-decimal atomic units', () => {
    const config = parseOperatorAuditConfigFromEnv({
      OPERATOR_AUDIT_TOKEN_IDS: '123,456,123',
      OPERATOR_AUDIT_WALLET_ADDRESS: wallet,
      POLYGON_RPC_URL: 'https://polygon.example.com',
      OPERATOR_AUDIT_UI_COLLATERAL: '1.25',
      OPERATOR_AUDIT_UI_TOKEN_BALANCES_JSON: '{"123":"2","456":3.5}',
    });

    expect(config.tokenIds).toEqual(['123', '456']);
    expect(config.uiEvidence).toEqual({
      collateralAtomic: '1250000',
      tokenBalances: { '123': '2000000', '456': '3500000' },
    });
    expect(config.toleranceAtomic).toBe(1n);
  });

  it('requires CLOB, UI, and onchain observations all to agree', () => {
    const comparisons = compareThreeWayBalances(
      ['123'],
      [{ assetId: '123', size: 2 }],
      { size: 1.25, allowances: {} },
      {
        chainId: 137,
        walletAddress: wallet,
        collateralAtomic: '1250000',
        tokenBalances: [{ tokenId: '123', atomic: '2000000' }],
      },
      {
        collateralAtomic: '1250000',
        tokenBalances: { '123': '2000001' },
      },
      1n
    );

    expect(comparisons.every((comparison) => comparison.matches)).toBe(true);
    expect(
      compareThreeWayBalances(
        ['123'],
        [{ assetId: '123', size: 2 }],
        { size: 1.25, allowances: {} },
        {
          chainId: 137,
          walletAddress: wallet,
          collateralAtomic: '1250000',
          tokenBalances: [{ tokenId: '123', atomic: '2000000' }],
        },
        undefined,
        1n
      ).every((comparison) => comparison.matches)
    ).toBe(false);
  });

  it('recognizes only a real terminal canary as completed evidence', () => {
    const base = {
      runId: 'canary-1',
      requestedAt: 1,
      updatedAt: 2,
      tokenId: '123',
      side: 'buy' as const,
      size: 1,
      price: 0.4,
      notionalUsd: 0.4,
      submissionAttempted: true,
    };
    expect(
      summarizeCanaryEvidence([{ ...base, dryRun: true, submitted: false, status: 'dry-run' }])
    ).toMatchObject({ fundedCanaryObserved: false, fundedCanaryTerminal: false });
    expect(
      summarizeCanaryEvidence([
        {
          ...base,
          dryRun: false,
          submitted: true,
          orderId: 'order-1',
          status: 'cancelled',
        },
      ])
    ).toMatchObject({ fundedCanaryObserved: true, fundedCanaryTerminal: true });
  });

  it('rejects stale dynamic fee schedules', () => {
    expect(
      dynamicFeesAreFresh(
        [
          {
            tokenId: '123',
            conditionId: `0x${'a'.repeat(64)}`,
            rate: 0,
            exponent: 0,
            fetchedAt: 100,
          },
        ],
        ['123'],
        1000,
        100
      )
    ).toBe(false);
  });
});
