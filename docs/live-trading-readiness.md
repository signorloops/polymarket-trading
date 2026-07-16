# Live-trading readiness

Automatic live trading remains intentionally disabled. This document is the release gate; a code path existing is not the same as an operator having validated it against the funded account.

## Current gate status

| Gate | Code status | Operational status |
| --- | --- | --- |
| Signed CLOB single-order canary | Implemented with a 5 USD hard cap, pre-submit intent journal, fail-closed kill switch, balance/allowance and heartbeat preflight, timeout cancellation and final-state confirmation | A real funded-account run must be performed and reviewed by the operator; any fill still requires manual balance/position reconciliation |
| Startup balance reconciliation | Implemented for every configured conditional token plus collateral; incomplete or malformed snapshots fail without changing risk state | Run `npm run reconcile:balances` against the funded account and compare with the Polymarket UI/on-chain holdings |
| Cross-process order idempotency | Implemented with an atomic filesystem claim in `.state/order-idempotency`; SDK POST retry is disabled and ambiguous submissions remain blocked | The state directory must be durable and shared by every submitter, with atomic create/rename/fsync semantics; use a transactional database before multi-host deployment |
| Partial-fill recovery | Implemented as cancel-confirm-unwind compensation; an incomplete arbitrage always opens the risk circuit breaker | Exercise with controlled test orders and verify the resulting positions independently |
| Cross-market USD payoff | Implemented only for explicit exhaustive payoff scenarios and displayed best-ask depth, including a configured fee buffer | Each payoff scenario set needs independent event-resolution and fee review |
| Multi-leg atomic execution | Not supported by the current CLOB adapter/API | **Hard blocker.** Compensation reduces risk but is not atomic execution |
| Order lifecycle feed | Polling and cancel confirmation are implemented; no authenticated user WebSocket is wired into the daemon | Validate polling under disconnect/rate-limit scenarios or add a user stream before unattended execution |

## Required operator sequence

1. Keep `liveTrading=false`. A missing canary kill-switch file is intentionally active/fail-closed; explicitly activate it with an operator reason while configuring the account.
2. Put `.state` on a durable, shared volume, set `RISK_STATE_FILE`, and back it up.
3. Configure real numeric token IDs, then run `npm run reconcile:balances`.
4. Run the canary in dry-run mode and inspect its request and state record.
5. Verify balance, allowance and heartbeat preflight, then deactivate the canary kill switch only for one explicitly confirmed, capped real canary.
6. Confirm the order's exchange status, wallet balances, local risk state and idempotency journal agree.
7. Re-activate the kill switch and test `canary:cancel-all`.
8. Review every configured cross-market payoff scenario and its fee buffer with an independent reviewer.
9. Do not remove the automatic live-trading guards until the multi-leg atomicity decision is resolved.

## Important semantics

- An idempotency key represents one logical order forever. SDK-level transient POST retry is disabled. If submission returns an ambiguous network error, reconcile the existing record; never retry with the same or a newly invented key until exchange state is known.
- Startup reconciliation is all-or-nothing. If any configured token is omitted or malformed, daemon startup fails when `RECONCILE_ON_STARTUP=true`.
- A successful compensating unwind still leaves the circuit breaker active for operator review.
- The legacy Frank-Wolfe/KL signal is dimensionless diagnostic data. It never enters the USD opportunity list.
- The public Gamma/CLOB data client never receives trading credentials; authenticated order and balance calls go only through the signed V2 adapter.
