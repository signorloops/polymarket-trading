# Polymarket 套利交易系统 — 面试讲解指南

> 这是一份**从零到精通**的项目讲解文档。你只要按这份文档的顺序往下讲，就能在面试中完整、有条理地展示这个项目的技术深度与工程复杂度。

---

## 目录

1. [一句话定位](#一句话定位)
2. [电梯演讲 30 秒版本](#电梯演讲-30-秒版本)
3. [项目背景与业务问题](#项目背景与业务问题)
4. [整体技术架构](#整体技术架构)
5. [核心算法（最重要、必背）](#核心算法最重要必背)
6. [模块详解](#模块详解)
7. [工程亮点](#工程亮点)
8. [关键数据指标](#关键数据指标)
9. [面试常见问题与回答模板](#面试常见问题与回答模板)
10. [如果面试官追问深的](#如果面试官追问深的)
11. [我在这个项目里做了什么](#我在这个项目里做了什么)

---

## 一句话定位

> **这是一个基于"边际多面体（marginal polytope）+ Frank-Wolfe 凸优化"的预测市场高频套利交易系统，运行在 Polymarket（基于 Polygon 链）之上。**

技术栈：**TypeScript（strict）+ Node.js + WebSocket + Docker + Prometheus/Grafana**
代码规模：**85 个源文件 / 63 个测试文件 / 942 个测试 / 93% 覆盖率**

---

## 电梯演讲 30 秒版本

> "这个项目是我做的一个预测市场套利交易系统，部署在 Polymarket 上。
> 核心是把套利问题建模成一个**凸优化问题**——可行域是边际多面体，目标函数是 KL 散度。
> 我用 **Frank-Wolfe 算法 + Bregman 投影**实时求解最优交易向量，
> 通过 WebSocket 接订单簿、SkipList 维护 O(log n) 的盘口数据，
> 同时实现了风控熔断、Kelly 仓位、Canary 灰度下单这一整套生产级链路。
> 全部 TypeScript strict，942 个测试，93% 覆盖，Docker + Prometheus 部署。"

---

## 项目背景与业务问题

### 什么是 Polymarket？

Polymarket 是一个**去中心化预测市场**：用户对未来事件（例如"2024 美国大选谁赢"）押注 YES 或 NO，价格落在 `[0, 1]` 之间，可以理解为市场认为该事件发生的概率。结算在 Polygon 链上，撮合通过链下 CLOB（Central Limit Order Book）。

### 为什么有套利？

1. **单市场套利**：理论上 `YES_price + NO_price = 1`。市场不平衡时会出现 `YES + NO < 1`（买齐两边稳赚）或 `> 1`（卖空两边稳赚）。
2. **跨市场套利**：例如"A 候选人赢"、"B 候选人赢"等多个互斥市场，概率之和应等于 1。出现偏差就有套利空间。
3. **结构性套利**：多事件之间存在逻辑约束（如"A 进决赛" ⊇ "A 夺冠"），价格违反约束即可套利。

### 为什么这是个难问题？

- **维度高**：相关市场可能几十上百维，约束更多，靠"看一眼"判断不行。
- **延迟敏感**：机会通常存在秒级窗口，算法必须微秒级响应。
- **风险大**：多腿交易不是原子的，一腿成交另一腿失败 = 单边裸头寸。
- **数值要稳**：价格在 `[0, 1]` 边界附近 `log` 函数会爆，必须做数值处理。

这就是为什么要用**凸优化 + 几何建模**——它能在高维下用统一框架解决问题，并给出**可证明**的最优交易向量。

---

## 整体技术架构

### 分层架构（自上而下）

```
┌─────────────────────────────────────────────────┐
│  数据输入层  Polymarket REST + WebSocket + 区块链 │
├─────────────────────────────────────────────────┤
│  市场数据层  DataPipeline → OrderBook(SkipList)  │
│            → ArbitrageDetector → DependencyGraph │
├─────────────────────────────────────────────────┤
│  策略层    Simple / CrossMarket / MarketMaking  │
│            / TrendFollowing → StrategyManager   │
├─────────────────────────────────────────────────┤
│  核心算法层 Frank-Wolfe + Bregman + LP/IP Solver │
├─────────────────────────────────────────────────┤
│  执行层    ExecutionEngine + RiskManager        │
│            + PositionSizing + OrderLifecycle    │
├─────────────────────────────────────────────────┤
│  运行时层  HTTP Server + Daemon + Canary CLI    │
├─────────────────────────────────────────────────┤
│  监控层    Pino Logger + Prometheus + Grafana   │
└─────────────────────────────────────────────────┘
```

### 目录结构（讲给面试官听）

```
src/
├── core/           # 核心算法（凸优化、几何建模）
│   ├── marginal-polytope.ts     # 边际多面体构造
│   ├── bregman-projection.ts    # Bregman 投影 / IPF
│   ├── frank-wolfe.ts           # FW 主算法
│   ├── line-search.ts           # 步长（黄金分割搜索）
│   ├── lmo.ts                   # 线性最小化 Oracle
│   └── init-fw.ts               # 可行初始点
├── market/         # 市场数据处理
│   ├── data-pipeline.ts         # WebSocket 数据流
│   ├── order-book.ts            # 订单簿（基于 SkipList）
│   ├── skip-list.ts             # SkipList 数据结构
│   ├── arbitrage-detector.ts    # 套利检测主入口
│   └── dependency-graph.ts      # 市场依赖图
├── strategies/     # 策略
│   ├── simple-arbitrage.ts      # 单市场套利
│   ├── cross-market-arbitrage.ts # 跨市场套利
│   ├── market-making.ts         # 做市
│   ├── trend-following.ts       # 趋势跟随
│   └── strategy-manager.ts      # 多策略信号聚合
├── execution/      # 执行引擎
│   ├── execution-engine.ts      # 订单执行
│   ├── order-manager.ts         # 订单状态机
│   ├── order-lifecycle.ts       # 订单生命周期
│   ├── risk-manager.ts          # 风控
│   ├── position-sizing.ts       # 仓位（Kelly）
│   ├── onchain-balance-reader.ts   # Polygon 只读余额对账
│   ├── operator-readiness-audit.ts # CLOB/UI/链上运营审计
│   └── canary-*.ts              # Canary 灰度下单（带 kill-switch）
├── optimization/   # LP/IP 求解器
├── api/            # Polymarket API 客户端（REST + WS + 签名 CLOB）
├── runtime/        # 守护进程 / HTTP 服务 / 配置
├── alerts/         # 告警（Slack / Email）
└── utils/          # 配置、日志、Metrics
```

---

## 核心算法（最重要、必背）

> **这一节是面试官最爱追问的部分。把这三个算法讲清楚，技术深度就立住了。**

### 1️⃣ 边际多面体（Marginal Polytope）

**它是什么**：所有"合法概率向量"组成的凸多面体 $\mathcal{M}$。

**约束有三类**：
1. **事件等式**：每个事件 outcome 概率和为 1，如 $\mu_{YES} + \mu_{NO} = 1$
2. **非负**：$\mu_i \geq 0$
3. **上界**：$\mu_i \leq 1$

**业务意义**：约束保证最终算出来的交易头寸是逻辑自洽的，不会出现"既买 YES 又买 NO 一起涨"这种荒谬组合。

**代码位置**：`src/core/marginal-polytope.ts`

---

### 2️⃣ Bregman 投影（KL 散度最小化）

**它干什么**：把当前市场价格向量 $\theta$，投影到边际多面体 $\mathcal{M}$，得到"最接近但合法"的概率向量 $\mu^*$。

**目标函数（KL 散度）**：

$$
D_{KL}(\mu \| \theta) = \sum_i \mu_i \log\frac{\mu_i}{\theta_i}
$$

**跨市场场景用广义 KL**（向量未归一化）：

$$
D_{GKL}(\mu \| \theta) = \sum_i \left[\mu_i \log\frac{\mu_i}{\theta_i} - \mu_i + \theta_i\right]
$$

**为什么用 KL 而不用欧氏距离？**
- KL 散度对**相对错价**敏感（对数比值），更符合概率/赔率场景
- 在概率单纯形上几何性质更好（Pinsker 不等式等）
- 在 $\mu, \theta > 0$ 时数值稳定可微

**求解方法**：迭代比例拟合（Iterative Proportional Fitting, IPF）。

**代码位置**：`src/core/bregman-projection.ts`

---

### 3️⃣ Frank-Wolfe 算法（条件梯度法）

**为什么用 Frank-Wolfe 不用梯度下降？**

| 对比 | 投影梯度下降 | **Frank-Wolfe** |
|------|------|------|
| 每步要做什么 | 投影到可行域（贵） | 求一个线性最小化（便宜） |
| 适合什么 | 简单可行域 | **复杂多面体** |
| 输出 | 内点 | **可行域顶点的凸组合（稀疏）** |

对于边际多面体这种**多面体可行域**，Frank-Wolfe 的 LMO（线性最小化 Oracle）退化成一个 LP，便宜得多，且解天然稀疏（适合"只动几个市场"的交易）。

**算法**：

$$
\mu_{t+1} = (1 - \gamma_t) \mu_t + \gamma_t s_t
$$

其中：
- $s_t = \arg\min_{s \in \mathcal{M}} \langle \nabla f(\mu_t), s\rangle$（LMO，调用 LP solver）
- $\gamma_t$：步长，本项目用**黄金分割线搜索**在真实目标上找最优

**收敛性**：凸目标 + 紧凸集，对偶 gap $O(1/T)$。

**项目里做的算法改进（2026-02-20 重写）**：
- 修复"迭代内全局 simplex 投影"破坏跨事件等式约束的 bug
- 步长从默认替换为真实目标的**黄金分割搜索**
- 收敛条件显式包含 `tolerance`，避免提前停止
- 跨市场用广义 KL，不混用标准 KL

**核心产物**：
```
guaranteedProfit = objective - gap
```
这是套利下界——保证盈利的最小值。

**代码位置**：`src/core/frank-wolfe.ts`

---

### 4️⃣ Kelly 仓位（改良版）

经典 Kelly：

$$
f^* = \frac{bp - q}{b}
$$

项目里加了**流动性折扣**：

$$
f = \frac{bp - q}{b} \cdot \sqrt{p}
$$

$\sqrt{p}$ 是对不确定性的"软"折扣，比纯 Kelly 保守，避免破产。

**代码位置**：`src/execution/position-sizing.ts`

---

## 模块详解

### 🔌 数据接入

- **`api/polymarket-client.ts`**：REST API 客户端（市场元数据、历史价格）
- **`api/polymarket-ws.ts`**：WebSocket 客户端（实时订单簿 / 成交）
- **`api/signed-clob-client.ts`**：**EIP-712 签名 CLOB 客户端**——用 `viem` 对订单做 EIP-712 签名后通过 Polymarket CLOB 提交
- **`market/data-pipeline.ts`**：统一数据管道——自动重连、心跳、消息路由

### 📚 订单簿（SkipList 加速）

- **`market/skip-list.ts`**：自实现的 SkipList
- **`market/order-book.ts`**：在 SkipList 上构造订单簿，**O(log n) 插入/删除，O(1) 最佳买卖价**
- **对比**：
  | 操作 | 排序数组 | SkipList | 提升 |
  |---|---|---|---|
  | 插入 | O(n) | O(log n) | ~100x |
  | 删除 | O(n) | O(log n) | ~100x |
  | 获取最佳价 | O(1) | O(1) | 持平 |

### 🎯 策略层

四种策略实现公共 `BaseStrategy` 接口，由 `StrategyManager` 聚合信号：
1. **SimpleArbitrage**：单事件 YES + NO ≠ 1
2. **CrossMarketArbitrage**：调用 FW + Bregman 找跨市场机会
3. **MarketMaking**：双边挂单赚价差
4. **TrendFollowing**：动量信号

### ⚙️ 执行层（生产级关键）

- **`execution-engine.ts`**：并行下单、订单跟踪、部分成交处理
- **`order-manager.ts`**：订单状态机（new → submitted → filled / partial / canceled）
- **`order-lifecycle.ts`**：生命周期事件 + 超时处理
- **`risk-manager.ts`**：
  - 仓位上限 / 单市场敞口上限
  - 每日亏损上限
  - **熔断机制**（Circuit Breaker）
  - 紧急停止（Emergency Stop）

### 🐦 Canary 系统（亮点）

**这是一个非常重要的生产级安全设计**：

- `canary-trade.ts`：单笔 canary 下单——默认 **dry-run**，必须**多个环境变量同时打开**才会真实下单
- `canary-kill-switch.ts`：基于**文件持久化**的"红色按钮"，激活后**阻断**所有真实 canary
- `canary-cancel-all.ts`：扫描状态文件，撤掉所有非终态订单
- `canary-trade-persistence.ts`：把每笔 canary 状态写到 `.state/canary-trades.json`，断电也不丢

**面试讲法**：
> "在接真实资金之前，我用 canary 单笔订单做灰度——文件锁 kill-switch + 多重环境变量门控 + 持久化状态。即使 NodeJS 进程挂掉重启，也能恢复未完成订单状态并尝试撤单，避免裸头寸。"

### 🏃 运行时（Daemon 模式）

- **`runtime/http-server.ts`**：内置 HTTP 服务，暴露：
  - `/health` 健康检查
  - `/ready` Kubernetes 就绪探针
  - `/metrics` Prometheus 指标
  - `/api/risk/status` 风控状态
- **`runtime/runtime-config.ts`**：daemon 配置加载 + Zod 校验
- **`scripts/daemon-smoke.ts`** & **`scripts/docker-smoke.ts`**：上线前烟雾测试

### 📊 可观测性

- **Pino** 结构化日志
- **Prometheus** 自定义 metrics：套利机会数、执行数、PnL、风控拦截数
- **Grafana** 仪表盘
- **Slack / Email** 告警

---

## 工程亮点

### 1. 性能优化

- **`Float64ArrayPool`**：对象池复用 typed array，**GC 停顿减少 90%**
- **稀疏约束**：只存非零系数，**内存降 60%+，处理速度 3-5x**
- **SkipList 订单簿**：插入/删除 100x 提升
- **微秒级算法**：Frank-Wolfe 2D 50 次迭代 0.10ms，5D 100 次迭代 0.28ms

### 2. 类型与质量

- **TypeScript strict mode**
- **ESLint 从 401 错误清到 0**
- **Zod** 运行时配置校验
- **942 个测试 / 93% 覆盖率**
- Husky + lint-staged + Prettier 提交前自动格式化

### 3. 依赖注入与可测性

- 单例统一封装在 `utils/singleton.ts`，所有模块导出 `reset()` 方便测试隔离
- 业务模块只依赖接口（如 `TradingClient`），mock 容易

### 4. 部署

- 多阶段 Dockerfile
- docker-compose 编排 trading + Prometheus + Grafana
- GitHub Actions CI（lint + test + build）
- 发布 workflow 自动打 tag

---

## 关键数据指标

| 维度 | 数字 |
|---|---|
| 总源文件 | 85 |
| 测试文件 | 63 |
| 测试用例 | 942 |
| 语句覆盖率 | 93%+ |
| 分支覆盖率 | 82%+ |
| ESLint 错误 | 0 |
| FW 2D 50 iter | 0.10ms |
| OrderBook 最佳价查询 | 0.001ms |
| OrderBook 更新 | 0.0002ms |

---

## 面试常见问题与回答模板

### Q1：「项目最难的点是什么？」

> "最难的是**把套利问题正确建模为凸优化**，并保证算法在数值边界稳定。
>
> 一开始我用标准 KL，但跨市场场景下价格向量并不归一化，导致 KL 数值爆炸。后来切到广义 KL，并且改了 Frank-Wolfe 的步长策略——从启发式步长改成在真实目标上做黄金分割线搜索。
>
> 还有一个 bug 是迭代过程中做了"全局 simplex 投影"，把跨事件的独立等式约束破坏了，跨市场套利完全失效。我重新设计了迭代——保持每一步的可行性，不再做全局投影。
>
> 修复后跨市场套利检测开始稳定工作，对偶 gap 在 100 次迭代内收敛到 1e-6。"

### Q2：「为什么用 Frank-Wolfe 而不是 SGD / Adam？」

> "三个原因：
> 1. **可行域是多面体**，投影到多面体本身就是一个 LP，跟 FW 的 LMO 一样贵。既然要解 LP，干脆直接 FW，省掉投影步。
> 2. **FW 的解天然稀疏**（顶点凸组合），对应到交易上是"只动少数几个市场"，符合实际执行。
> 3. **可证明收敛 + 实时计算 gap**，gap 直接对应 `guaranteedProfit` 的下界——非常符合套利场景"宁可不做也别错做"的要求。"

### Q3：「多腿套利不是原子的，一腿成交另一腿失败怎么办？」

> "三层防护：
> 1. **执行前**：RiskManager 检查总敞口、单市场敞口、当日亏损，任一超限就 reject。
> 2. **执行中**：用 `Promise.all` 并行下单缩短窗口，OrderManager 跟踪每个 leg 的状态。
> 3. **执行后**：检测到部分成交立即触发对冲——要么撤剩余腿，要么用市价单 unwind 已成交腿。
>
> 另外有 **circuit breaker** 熔断：当日累计亏损或单笔异常超阈值就停掉整个系统。
>
> 真实上线前先用 **Canary 灰度**——单笔小单 + kill-switch 文件锁，验证整个链路。"

### Q4：「你怎么处理 Polymarket WebSocket 断线？」

> "DataPipeline 有完整的重连逻辑——指数退避、心跳检测、订阅恢复。断线时本地订单簿不强制清空，重连后由 snapshot + delta 补齐。
>
> 在 trading system 主循环里，如果 pipeline 长时间 disconnected，runtime 的 `/ready` 接口会返回 not ready，让 K8s 不路由流量过来。"

### Q5：「这套系统现在跑没跑真钱？」

> "**默认不跑真钱**，代码里 `liveTrading: true` 会直接抛错——这是有意的 safety guard，等 CLOB 端到端联调完成才会解开。
>
> 已经实现：
> - 完整的 EIP-712 签名 CLOB 客户端
> - 灰度 canary 下单工具链（含 kill-switch）
> - 风控全链路
>
> 还在做的：
> - 全链路烟雾测试在 Polygon mainnet 上跑通
> - canary 实战观察 24/48/72 小时无异常再开 live"

### Q6：「测试覆盖怎么保证的？」

> "几个原则：
> 1. **TDD**：新功能先写测试。`tests/` 目录跟 `src/` 一一对应。
> 2. **共享状态模块都暴露 `reset()`**——这是我踩过坑后总结的：测试间状态泄漏会让一切非确定性。
> 3. **fake timers + setSystemTime**——所有跟时间相关的逻辑用 `jest.useFakeTimers()`，禁止业务代码内部直接调 `Date.now()` 而不可注入。
> 4. **Integration test 单独跑**——`tests/integration/` 跑完整链路；单元测试只测纯函数。
>
> 最终 942 个用例，93% 覆盖。"

---

## 如果面试官追问深的

### "KL 散度的梯度怎么推？"

广义 KL 对 $\mu_i$ 求偏导：

$$
\frac{\partial}{\partial \mu_i}\left[\mu_i \log\frac{\mu_i}{\theta_i} - \mu_i + \theta_i\right] = \log\frac{\mu_i}{\theta_i} + 1 - 1 = \log\frac{\mu_i}{\theta_i}
$$

标准 KL 没有 $-\mu_i$ 那项，所以梯度是 $\log(\mu_i / \theta_i) + 1$。

### "LMO 在多面体上怎么求？"

LMO 就是 $\min \langle c, s \rangle, s \in \mathcal{M}$，是标准 LP。本项目用 `javascript-lp-solver`，单纯形法 + 输入维度校验 + 可行性后置检查。如果是 MILP，加 IP solver，失败时回退到自实现的**分支定界**。

### "为什么 SkipList 而不是红黑树？"

- 实现简单（红黑树调旋转代码很烦）
- 期望复杂度一样 O(log n)，**常数更小**
- 顺序遍历快（链表结构）——拿最佳 5 档报价时直接走 level 1 链表，cache friendly
- 易于并发扩展（虽然这个项目目前是单线程）

### "为什么不用 Rust / C++？"

- TypeScript 让团队（包括前端 / 数据科学家）协作成本低
- V8 + JIT 对热点代码足够快（典型迭代 < 1ms）
- 性能瓶颈实际在 **网络 IO + 链上确认**，不在 CPU
- 真要优化，可以把核心算法编译为 WebAssembly 嵌入，不必整体重写

---

## 我在这个项目里做了什么

> 面试时根据真实情况勾选要讲的部分。下面是项目里可以明确指出的工程产出：

- 🔬 **算法层**：实现 Frank-Wolfe + Bregman 投影 + 边际多面体，并修复了 simplex 投影破坏跨事件约束的关键 bug
- ⚡ **性能层**：用 SkipList 重写订单簿（100x），Float64ArrayPool 减 90% GC，稀疏约束减 60% 内存
- 🛡️ **风控层**：实现 RiskManager（仓位/敞口/损失/熔断/紧急停止）
- 🐦 **Canary 系统**：从零设计灰度下单 + kill-switch + 状态持久化 + 自动撤单
- 🔌 **API 层**：EIP-712 签名 CLOB 客户端（viem），WebSocket 重连与订单簿恢复
- 📦 **运行时**：Daemon 模式 + HTTP 健康检查 + Prometheus metrics + Docker compose
- ✅ **质量**：把 ESLint 从 401 错误清到 0，测试从 0 写到 942 / 93% 覆盖
- 📚 **文档**：架构图、算法理论手册、API 文档、部署文档全套中英双语

---

## 讲解策略建议

1. **开场 30 秒**：照"电梯演讲"那段念，先把定位讲清楚
2. **铺架构 2 分钟**：用分层图带过一遍，告诉面试官"我们今天可以从任意一层切下去深聊"
3. **重点讲核心算法 3-5 分钟**：边际多面体 → Bregman → Frank-Wolfe，画图最好（黑板/纸笔）
4. **挑 1 个亮点深讲 3 分钟**：根据面试岗位选——
   - **算法岗**：讲 Frank-Wolfe 步长修复
   - **后端 / 基础架构岗**：讲 Canary + RiskManager + Daemon
   - **量化 / 交易岗**：讲 Kelly 仓位 + 跨市场套利建模
   - **性能岗**：讲 SkipList + Float64ArrayPool
5. **结尾**：主动说"还没真实上线，等 canary 跑稳"——展示工程审慎

**记住**：面试不是背书，而是展示**你怎么思考问题**。任何一个细节都可以反问"你想听哪一层？"
