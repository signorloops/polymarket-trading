# Polymarket 项目 Mermaid 学习文档

这份文档用 Mermaid 图把项目核心链路串起来，目标是帮助你快速建立“模块职责 + 数据流 + 算法流”的整体心智模型。

---

## 1. 全局架构（先看这张）

```mermaid
flowchart TB
    A["External APIs<br/>Polymarket REST/WS + RPC"] --> B["Data Pipeline"]
    B --> C["OrderBook Manager"]
    C --> D["Arbitrage Detector"]
    D --> E["Strategies"]
    E --> F["Strategy Manager / Signal Aggregation"]
    F --> G["Execution Engine"]
    G --> H["Risk Manager"]
    H --> G
    G --> I["Exchange / On-chain Execution"]
    D --> J["Optimization Core<br/>Frank-Wolfe + LMO + Solvers"]
    J --> D
    G --> K["Metrics + Alerts + Logs"]
```

你要抓住 3 条主线：
- 市场数据主线：`API -> Data Pipeline -> OrderBook -> Arbitrage Detector`
- 决策主线：`Detector -> Strategy -> Aggregation -> Execution`
- 约束优化主线：`Detector <-> Optimization Core`

---

## 2. 启动到单次检测循环

```mermaid
sequenceDiagram
    participant App as TradingSystem
    participant Pipe as DataPipeline
    participant OB as OrderBookManager
    participant Det as ArbitrageDetector
    participant SM as StrategyManager
    participant Ex as ExecutionEngine

    App->>Pipe: initialize/start
    Pipe-->>OB: market updates (bids/asks/trades)
    App->>Det: runDetectionCycle()
    Det->>OB: read snapshots/liquidity
    Det->>Det: detect single-market opportunities
    Det->>Det: detect cross-market opportunities (FW/LP/IP)
    Det-->>SM: opportunities/signals
    SM->>SM: priority/weighted/consensus aggregation
    SM-->>Ex: executable signal(s)
    Ex->>Ex: risk checks + sizing
    Ex-->>App: execution result
```

重点理解：
- 检测和执行是分离的，执行前一定走风控。
- 跨市场检测不是规则硬编码，而是“约束 + 优化”。

---

## 3. 跨市场套利（核心算法链）

```mermaid
flowchart TD
    A["StrategyMarketData[]"] --> B["MarketDependencyGraph.clear()"]
    B --> C["addMarket(...) -> auto event node"]
    C --> D["buildConstraintMatrix()"]
    D --> E["constraints (A,b,Aeq,beq)"]
    A --> F["theta = prices (clipped)"]
    E --> G["buildFeasibleInitialPoint(theta, constraints)"]
    F --> H["objective = generalized KL"]
    G --> I["frankWolfe(initialMu, objective, gradient, lmo)"]
    H --> I
    E --> J["LMO: linearMinimizationOracle(grad, constraints)"]
    J --> I
    I --> K["mu* / gap / iterations"]
    K --> L["tradeVector = mu* - theta"]
    K --> M["expectedProfit + confidence"]
```

对应代码：
- 约束图构建：`src/market/dependency-graph.ts`
- 策略主流程：`src/strategies/cross-market-arbitrage.ts`
- 数学目标：`src/utils/math.ts`

---

## 4. Frank-Wolfe 迭代细节

```mermaid
flowchart TD
    A["mu_t"] --> B["compute objective f(mu_t)"]
    B --> C["compute grad g_t"]
    C --> D["LMO: s_t = argmin <g_t, s>"]
    D --> E["gap = <g_t, mu_t - s_t>"]
    E --> F{"gap <= tolerance-scaled?"}
    F -- yes --> G["converged"]
    F -- no --> H["lineSearchObjective(mu_t, s_t, f)"]
    H --> I["gamma in [0,1]"]
    I --> J["mu_{t+1} = (1-gamma)mu_t + gamma s_t"]
    J --> A
```

你会看到两个关键改进：
- `line-search` 现在走真实目标函数，不是局部近似。
- 迭代不再做错误的全局 simplex 投影，避免破坏独立等式组可行性。

代码：`src/core/frank-wolfe.ts`、`src/core/line-search.ts`

---

## 5. Dependency Graph 到约束矩阵

```mermaid
flowchart LR
    A["Markets"] --> B["Event grouping"]
    B --> C["Event sum constraints: Σ event_i = 1"]
    B --> D["Non-negativity: x_i >= 0"]
    E["Edges: mutually_exclusive / conditional"] --> F["Cross-event inequalities"]
    C --> G["Constraint Matrix"]
    D --> G
    F --> G
```

学习点：
- `addMarket()` 会自动创建/更新 event 节点，因此“只传 market”也能得到事件等式约束。
- `buildConstraintMatrix()` 内部使用 `marketId -> index` 映射，提高大规模市场构建速度。

---

## 6. 求解器选择逻辑（LP/IP）

```mermaid
flowchart TD
    A["Optimization Problem"] --> B{"Integer vars?"}
    B -- no --> C["solveLP() -> javascript-lp-solver backend"]
    B -- yes --> D["solveIP()"]
    D --> E["validate dimensions/index bounds"]
    E --> F["LP relaxation"]
    F --> G{"nodeLimit <= 1 ?"}
    G -- yes --> H["return status=error (legacy semantics)"]
    G -- no --> I["try MILP backend"]
    I --> J{"backend success?"}
    J -- yes --> K["return MILP solution + relaxation gap"]
    J -- no --> L["fallback branch-and-bound"]
```

学习顺序建议：
1. 先看 LP：`src/optimization/lp-solver.ts`
2. 再看 IP：`src/optimization/ip-solver.ts`

---

## 7. OrderBook + SkipList 结构

```mermaid
flowchart TB
    A["OrderBook.update(bids, asks)"] --> B["Map(price->size) update"]
    B --> C["SkipList insert/delete"]
    C --> D["bidDepth/askDepth incremental update"]
    D --> E["getBestBid() => bidLevels.getLast()"]
    D --> F["getBestAsk() => askLevels.getFirst()"]
    E --> G["spread / midPrice / VWAP / slippage"]
    F --> G
```

数据结构关系：

```mermaid
flowchart LR
    H["head"] --> N1["price p1"]
    N1 --> N2["price p2"]
    N2 --> N3["price p3"]
    N3 --> T["tail"]
```

为什么快：
- 最优 bid/ask 是 O(1) 读取（头尾指针）。
- 插入/删除/查找是 O(log n)。
- 深度是增量维护，不需要每次全量重算。

---

## 8. 信号聚合决策图

```mermaid
flowchart TD
    A["signals from strategies"] --> B{"mode"}
    B -- priority --> C["highest confidence wins"]
    B -- weighted --> D["confidence-weighted price/size"]
    D --> E["confidence-weighted buy/sell vote"]
    B -- consensus --> F["group by market+direction"]
    F --> G["check minConsensus"]
    C --> H["aggregated signal"]
    E --> H
    G --> H
```

代码：`src/strategies/signal-aggregation.ts`

---

## 9. 检测与执行风控闭环

```mermaid
flowchart LR
    A["Arbitrage Opportunity"] --> B["Position Sizing"]
    B --> C["Risk Checks<br/>exposure/loss/slippage"]
    C --> D{"pass?"}
    D -- no --> E["reject / alert"]
    D -- yes --> F["place orders"]
    F --> G["track fills"]
    G --> H["update risk state + metrics"]
    H --> A
```

学习时建议同时打开：
- 执行：`src/execution/execution-engine.ts`
- 风控：`src/execution/risk-manager.ts`

---

## 10. 推荐学习路径（按图走）

1. 先看第 1、2 张图，建立全局流程。
2. 再看第 3、4、5 张图，理解“约束怎么变成可优化问题”。
3. 接着看第 6、7 张图，理解求解器与订单簿性能。
4. 最后看第 8、9 张图，理解从信号到执行的业务闭环。

如果你按这个顺序看代码，进入速度会比“按目录硬读”快很多。
