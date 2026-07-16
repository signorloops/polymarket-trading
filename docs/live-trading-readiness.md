# Live-trading readiness

Automatic live trading remains intentionally disabled. This document is the release gate; a code path existing is not the same as an operator having validated it against the funded account.

## Current gate status

| Gate | Code status | Operational status |
| --- | --- | --- |
| Signed CLOB single-order canary | Implemented with a 5 USD hard cap, dynamic V2 fee lookup, authenticated user-channel readiness, zero-open-order check, intent journal, kill switch, balance/allowance and heartbeat preflight, timeout cancellation and final-state confirmation | A real funded-account run must still be performed and reviewed by the operator; any fill requires deliberate position handling |
| Three-way balance reconciliation | `audit:operator-readiness` compares authenticated CLOB balances, operator-supplied UI evidence and Polygon pUSD/CTF balances in atomic units | Run it against the funded account before and after Canary; UI evidence cannot be inferred by the bot |
| Cross-process order idempotency | Atomic file journal remains available for one host; PostgreSQL primary-key claims and conditional state transitions are implemented for multi-machine deployments | Configure `ORDER_IDEMPOTENCY_DATABASE_URL[_FILE]` and exercise failover against the production database before multiple submitters are enabled |
| Partial-fill recovery | Implemented as cancel-confirm-unwind compensation; an incomplete arbitrage always opens the risk circuit breaker | Exercise with controlled test orders and verify the resulting positions independently |
| Cross-market USD payoff | Implemented only for explicit exhaustive payoff scenarios and displayed depth; dynamic V2 rate/exponent metadata is cached with a conservative stale-data fallback | Each payoff scenario set still needs independent event-resolution review |
| Multi-leg atomic execution | Not supported by the current CLOB adapter/API | **Hard blocker.** Compensation reduces risk but is not atomic execution |
| Order lifecycle feed | Authenticated user WebSocket implements private order/trade lifecycle parsing, reconnect/PONG health and per-order waiting; Canary requires a healthy channel before submit while signed REST polling remains authoritative fallback | Validate it with the funded API key and controlled order events before unattended execution |

## Required operator sequence

1. Keep `liveTrading=false`. A missing canary kill-switch file is intentionally active/fail-closed; explicitly activate it with an operator reason while configuring the account.
2. Put `.state` on a durable volume, set `RISK_STATE_FILE`, and configure PostgreSQL idempotency for any multi-host setup.
3. Configure real numeric token IDs and UI balance evidence, then run `npm run audit:operator-readiness`.
4. Run the canary in dry-run mode and inspect its request and state record.
5. Verify balance, allowance and heartbeat preflight, then deactivate the canary kill switch only for one explicitly confirmed, capped real canary.
6. Re-run `audit:operator-readiness`; confirm exchange status, UI, Polygon balances, local risk state and the PostgreSQL journal agree.
7. Re-activate the kill switch and test `canary:cancel-all`.
8. Review every configured cross-market payoff scenario and its fee buffer with an independent reviewer.
9. Do not remove the automatic live-trading guards until the multi-leg atomicity decision is resolved.

## Important semantics

- An idempotency key represents one logical order forever. SDK-level transient POST retry is disabled. If submission returns an ambiguous network error, reconcile the existing record; never retry with the same or a newly invented key until exchange state is known.
- Startup reconciliation is all-or-nothing. If any configured token is omitted or malformed, daemon startup fails when `RECONCILE_ON_STARTUP=true`.
- A successful compensating unwind still leaves the circuit breaker active for operator review.
- The legacy Frank-Wolfe/KL signal is dimensionless diagnostic data. It never enters the USD opportunity list.
- The public Gamma/CLOB data client never receives trading credentials; authenticated order and balance calls go only through the signed V2 adapter.
