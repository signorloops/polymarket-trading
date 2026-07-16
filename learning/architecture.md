# Polymarket 套利交易系统 — 架构详解

## 目录

1. [项目概览](#1-项目概览)
2. [目录结构](#2-目录结构)
3. [核心架构与数据流](#3-核心架构与数据流)
4. [核心算法](#4-核心算法)
5. [市场数据层](#5-市场数据层)
6. [执行引擎](#6-执行引擎)
7. [策略系统](#7-策略系统)
8. [API 集成](#8-api-集成)
9. [区块链集成](#9-区块链集成)
10. [基础设施](#10-基础设施)
11. [测试架构](#11-测试架构)
12. [部署](#12-部署)
13. [性能优化](#13-性能优化)
14. [安全实践](#14-安全实践)

---

## 1. 项目概览

本项目是一个面向 [Polymarket](https://polymarket.com)（预测市场）的 **自动化套利交易系统**。它利用数学优化算法（Frank-Wolfe 条件梯度法、Bregman 投影、边际多面体分析）实时检测市场定价偏差，并自动执行套利交易。

### 技术栈

| 类别 | 技术 |
|------|------|
| 语言 | TypeScript 5.9（严格模式，ES2020 目标） |
| 运行时 | Node.js 20 |
| 模块系统 | ESM |
| 优化求解 | `javascript-lp-solver`（线性/整数规划） |
| 实时通信 | `ws`（WebSocket 客户端） |
| HTTP | `axios` |
| 校验 | `zod`（运行时 schema 校验） |
| 告警 | `@slack/webhook`、`nodemailer` |
| 测试 | Jest 30 + ts-jest |
| 代码质量 | ESLint 10、Prettier 3.8、Husky 8 |
| 容器化 | Docker（多阶段构建）、docker-compose |
| 监控 | Prometheus + Grafana |

### 核心指标

- **68** 个 TypeScript 源文件，约 **14,000** 行生产代码
- **942+** 个单元/集成测试，覆盖率 **93%+**
- **0** 个 ESLint 错误
- TypeScript 严格模式全量通过

---

## 2. 目录结构

```
src/
├── index.ts                    # 主入口：PolymarketTradingSystem 类
│
├── core/                       # 核心优化算法（8 文件）
│   ├── frank-wolfe.ts          # Frank-Wolfe 条件梯度法
│   ├── bregman-projection.ts   # Bregman 散度投影
│   ├── marginal-polytope.ts    # 边际多面体（可行域）
│   ├── lmo.ts                  # 线性最小化预言机（LMO）
│   ├── line-search.ts          # 黄金分割线搜索
│   ├── init-fw.ts              # Frank-Wolfe 初始化
│   ├── arbitrage-utils.ts      # 套利工具函数
│   └── frank-wolfe-types.ts    # 类型定义
│
├── market/                     # 市场数据与套利检测（7 文件）
│   ├── data-pipeline.ts        # WebSocket 数据管线
│   ├── order-book.ts           # 订单簿（SkipList 结构）
│   ├── order-book-manager.ts   # 订单簿生命周期管理
│   ├── arbitrage-detector.ts   # 套利检测引擎
│   ├── dependency-graph.ts     # 跨市场依赖图
│   ├── constraint-builder.ts   # 多面体约束构建
│   └── skip-list.ts            # O(log n) 跳表数据结构
│
├── execution/                  # 交易执行与风控（6 文件）
│   ├── execution-engine.ts     # 执行引擎（多腿并行下单）
│   ├── order-manager.ts        # 订单状态管理
│   ├── position-sizing.ts      # Kelly 准则仓位计算
│   ├── risk-manager.ts         # 风控：熔断、限仓、止损
│   ├── execution-metrics.ts    # 执行指标记录
│   └── types.ts                # 类型定义
│
├── strategies/                 # 交易策略（8 文件）
│   ├── base.ts                 # 策略基类接口
│   ├── simple-arbitrage.ts     # 单市场套利
│   ├── cross-market-arbitrage.ts # 跨市场套利
│   ├── market-making.ts        # 做市策略
│   ├── trend-following.ts      # 趋势跟踪策略
│   ├── signal-aggregation.ts   # 多信号聚合
│   └── strategy-manager.ts     # 策略编排管理
│
├── api/                        # 外部 API 客户端（3 文件）
│   ├── polymarket-client.ts    # REST API 客户端
│   ├── polymarket-ws.ts        # WebSocket 连接
│   └── index.ts
│
├── optimization/               # LP/IP 求解器（4 文件）
│   ├── lp-solver.ts            # 线性规划封装
│   ├── ip-solver.ts            # 整数规划封装
│   ├── lp-solver-utils.ts      # LP 工具函数
│   └── ip-solver-utils.ts      # IP 工具函数
│
├── utils/                      # 工具模块（13 文件）
│   ├── config.ts               # 配置加载与导出
│   ├── config-schema.ts        # Zod 校验 schema
│   ├── logger.ts               # 结构化日志
│   ├── math.ts                 # 数学工具（向量、KL 散度）
│   ├── errors.ts               # 错误处理
│   ├── metrics.ts              # Prometheus 指标
│   ├── metric-types.ts         # 指标类型定义
│   ├── metric-registry.ts      # 指标注册中心
│   ├── singleton.ts            # 单例模式辅助
│   ├── crypto-utils.ts         # 加密工具
│   ├── config-encryption.ts    # 配置加解密
│   ├── performance-alert-manager.ts # 性能告警
│   └── percentile.ts           # 百分位数计算
│
├── alerts/                     # 告警通知（多文件）
│   ├── alert-notification-service.ts # 告警分发
│   └── channels/               # Slack / Discord / Email / PagerDuty
│
├── lifecycle/                  # 应用生命周期（2 文件）
│   ├── shutdown.ts             # 优雅关闭处理
│   └── index.ts
│
├── security/                   # 安全模块（1 文件）
│   └── api-security.ts         # API 密钥管理与请求签名
│
├── di/                         # 依赖注入（1 文件）
│   └── container.ts            # DI 容器
│
└── types/                      # 类型声明（2 文件）
    ├── javascript-lp-solver.d.ts
    └── nodemailer.d.ts

benchmarks/                     # 性能基准测试
├── frank-wolfe.bench.ts
├── math.bench.ts
└── orderbook.bench.ts

tests/                          # 测试文件（镜像 src/ 结构）
docs/                           # 文档
```

---

## 3. 核心架构与数据流

### 3.1 系统全景

```
                    ┌──────────────────────────────────────────────┐
                    │        PolymarketTradingSystem               │
                    │       (src/index.ts — 主入口)                │
                    │                                              │
                    │  initialize() → start() → stop()            │
                    │  runDetectionCycle() → executeOpportunity()  │
                    └──────────────────┬───────────────────────────┘
                                       │
              ┌────────────────────────┼──────────────────────┐
              ▼                        ▼                      ▼
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │   Data Pipeline   │    │   Arbitrage      │    │   Strategy       │
   │   (数据管线)       │    │   Detector       │    │   Manager        │
   │                   │    │   (套利检测器)     │    │   (策略管理器)    │
   │  WebSocket 连接   │    │                  │    │                  │
   │  消息解析/分发     │    │  单市场/跨市场    │    │  多策略编排       │
   └────────┬─────────┘    │  机会检测         │    │  信号聚合         │
            │              └────────┬─────────┘    └────────┬─────────┘
            │                       │                       │
            ▼                       ▼                       ▼
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │   Order Book      │    │   Core Algorithms│    │   Trade Signal   │
   │   (订单簿)        │    │   (核心算法)      │    │   (交易信号)      │
   │                   │    │                  │    │                  │
   │  SkipList 结构    │    │  Frank-Wolfe     │    │  buy/sell/hold   │
   │  VWAP / 流动性    │    │  Bregman 投影    │    │  confidence      │
   │  滑点估算         │    │  边际多面体       │    │  size / price    │
   └──────────────────┘    └──────────────────┘    └──────────────────┘
                                       │
                                       ▼
                            ┌──────────────────┐
                            │ Position Sizing   │
                            │ (仓位计算)        │
                            │                  │
                            │ Kelly 准则        │
                            │ 流动性调整         │
                            └────────┬─────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │ Execution Engine  │
                            │ (执行引擎)        │
                            │                  │
                            │ 多腿并行下单      │
                            │ 订单状态追踪      │
                            │ 部分成交处理      │
                            └────────┬─────────┘
                                     │
                          ┌──────────┼──────────┐
                          ▼          ▼          ▼
                   ┌───────────┐ ┌────────┐ ┌──────────┐
                   │ Risk Mgr  │ │ API    │ │ Metrics  │
                   │ (风控)     │ │ Client │ │ & Alerts │
                   │           │ │        │ │          │
                   │ 熔断器    │ │ REST   │ │ Prometheus│
                   │ 止损限额  │ │ 下单   │ │ Slack    │
                   │ 敞口控制  │ │ 撤单   │ │ Email    │
                   └───────────┘ └────────┘ └──────────┘
```

### 3.2 核心数据流

整个系统的数据流可以用一条链路概括：

```
市场价格 → 套利检测 → 仓位计算 → 风控校验 → 下单执行 → 状态追踪
```

具体步骤：

1. **数据采集**：`DataPipeline` 通过 WebSocket 订阅实时交易和订单簿更新
2. **订单簿维护**：`OrderBook` 使用 SkipList 维护各市场的买卖盘
3. **套利检测**：`ArbitrageDetector` 调用 Frank-Wolfe 算法在边际多面体上求解，发现定价偏差
4. **信号生成**：`StrategyManager` 聚合多个策略的信号，形成交易决策
5. **仓位计算**：`PositionSizing` 基于 Kelly 准则计算最优下注比例
6. **风控校验**：`RiskManager` 检查敞口限额、日亏损上限、熔断状态
7. **执行下单**：`ExecutionEngine` 并行提交多腿订单到 Polymarket API
8. **状态追踪**：`OrderManager` 追踪订单状态，`Metrics` 记录执行指标

### 3.3 组件生命周期

所有核心组件采用 **单例模式**（Singleton），通过 `src/utils/singleton.ts` 统一管理：

| 单例组件 | 职责 |
|---------|------|
| `DataPipeline` | WebSocket 连接与市场数据分发 |
| `ArbitrageDetector` | 套利机会检测 |
| `ExecutionEngine` | 订单执行 |
| `RiskManager` | 风控与仓位管理 |
| `Logger` | 全局日志 |
| `MetricsRegistry` | Prometheus 指标收集 |

每个单例都暴露 `reset()` 方法，供测试清理状态。

---

## 4. 核心算法

本系统的数学核心是 **凸优化**：将套利检测转化为在 **边际多面体**（Marginal Polytope）上最小化 **KL 散度** 的问题。

### 4.1 边际多面体（Marginal Polytope）

**文件**：`src/core/marginal-polytope.ts`

边际多面体 M 是所有合法概率分布构成的凸集。对于预测市场，它编码以下约束：

- **概率和约束**：每个事件的所有结果概率之和 = 1（例如 YES + NO = 1）
- **市场一致性**：相关市场间的概率必须一致
- **互斥约束**：互斥事件的概率之和 ≤ 1

```typescript
// 接口示例
polytope.addEvent('election', ['YES', 'NO']);     // 添加事件
polytope.updateMarketPrice('election', 0, 0.6);   // 更新价格
const constraints = polytope.getConstraints();      // 获取约束矩阵
```

### 4.2 Frank-Wolfe 条件梯度法

**文件**：`src/core/frank-wolfe.ts`

在边际多面体 M 上求解：

```
minimize  D_KL(μ ‖ θ)    （KL 散度）
s.t.      μ ∈ M           （μ 在多面体内）
```

其中 θ 是当前市场价格向量，μ 是「无套利价格」。两者的差距就是套利利润的数学保证。

**迭代过程**：

```
输入：市场价格 θ，多面体约束 M
初始化：μ₀ ∈ M（多面体内的某个可行点）

for t = 0, 1, 2, ... :
    1. 计算梯度 ∇f(μₜ) = log(μₜ) - log(θ)    （KL 散度梯度）
    2. LMO 步骤：sₜ = argmin_{v ∈ M} ⟨∇f(μₜ), v⟩   （求解线性规划）
    3. 线搜索：γₜ = argmin_{γ ∈ [0,1]} f((1-γ)μₜ + γsₜ)
    4. 更新：μₜ₊₁ = (1-γₜ)μₜ + γₜsₜ
    5. 收敛检查：若 ⟨∇f(μₜ), μₜ - sₜ⟩ < ε 则停止

输出：μ* ≈ 多面体上最接近 θ 的点
       gap = D_KL(μ* ‖ θ) = 保证套利利润
```

### 4.3 线性最小化预言机（LMO）

**文件**：`src/core/lmo.ts`

Frank-Wolfe 每次迭代都需要解一个线性规划：在多面体的顶点中找到沿梯度方向最小的那个。LMO 封装了对 `javascript-lp-solver` 的调用。

### 4.4 Bregman 投影

**文件**：`src/core/bregman-projection.ts`

将价格向量投影到多面体上，使用 **Bregman 散度**（KL 散度的推广）作为距离度量。这比欧氏距离投影更适合概率分布。

算法使用 **障碍收缩法**（Barrier Shrinkage）：

```
1. 初始化大的 ε（障碍参数）
2. 在 ε-扩展的可行域内求解
3. 逐步缩小 ε，逼近真正的最优解
4. 最终 μ* 就是最优投影点
```

### 4.5 Kelly 准则（仓位计算）

**文件**：`src/execution/position-sizing.ts`

修正版 Kelly 公式：

```
f = (b × p - q) / b × √p
```

其中：
- `f` = 最优下注比例
- `b` = 赔率（`1 - price`，对二元市场）
- `p` = 胜率（来自套利检测的置信度）
- `q` = 1 - p

系统使用 **保守 Kelly**（乘以 0.25），并叠加流动性和风控约束：

```typescript
最终仓位 = min(
  Kelly 建议量,
  流动性限制（订单簿深度 × MAX_POSITION_PCT）,
  风控限制（MAX_EXPOSURE - 当前敞口）,
  最大单次下注（资本 × MAX_BET_FRACTION）
)
```

---

## 5. 市场数据层

### 5.1 WebSocket 数据管线

**文件**：`src/market/data-pipeline.ts`

```
Polymarket WebSocket
       │
       ▼
  DataPipeline
  ├── 连接管理（自动重连 + 指数退避，最大 60s）
  ├── 心跳（ping/pong 每 30s）
  ├── 消息解析
  └── 事件分发
       ├── trade 事件 → 交易记录
       ├── orderbook 事件 → 订单簿更新
       └── price_change 事件 → 价格变动
```

### 5.2 订单簿

**文件**：`src/market/order-book.ts`、`src/market/skip-list.ts`

订单簿使用 **SkipList**（跳表）作为底层数据结构，提供 O(log n) 的插入/删除/查找：

| 操作 | 时间复杂度 | 典型耗时 |
|------|-----------|---------|
| 最优买/卖价查询 | O(1) | 0.001ms |
| VWAP 计算 | O(k)，k = 价格层数 | 0.001ms |
| 订单更新 | O(log n) | 0.0002ms |
| 流动性分析 | O(k) | 0.001ms |

功能包括：
- **VWAP 计算**：给定数量的加权平均成交价
- **滑点估算**：大单对市场价格的影响
- **流动性分析**：买卖盘深度和价差

### 5.3 套利检测器

**文件**：`src/market/arbitrage-detector.ts`

两种套利模式：

**单市场套利**：当 YES 价格 + NO 价格 ≠ $1 时，存在套利机会
- 偏差阈值：1%
- 例：YES = $0.55, NO = $0.40 → 总价 $0.95 → 买入两侧赚 $0.05

**跨市场套利**：多个相关市场的概率不一致
- 使用 Frank-Wolfe 优化检测
- 依赖 `DependencyGraph` 建模市场关系
- 利润由 KL 散度的 gap 保证

### 5.4 市场依赖图

**文件**：`src/market/dependency-graph.ts`

建模市场之间的关系：

```
事件类型：binary（二元）、categorical（多选）、conditional（条件）
边类型：mutually_exclusive（互斥）、conditional（条件）、temporal（时序）、combinatorial（组合）
```

依赖图用于构建约束矩阵，确保跨市场套利检测的正确性。

---

## 6. 执行引擎

### 6.1 执行流程

**文件**：`src/execution/execution-engine.ts`

```
套利机会
  │
  ├── 1. 风控预检查（RiskManager.checkLimits()）
  │     ├── 日亏损上限
  │     ├── 总敞口上限
  │     └── 熔断状态
  │
  ├── 2. 仓位计算（PositionSizing.calculate()）
  │     ├── Kelly 准则
  │     ├── 流动性限制
  │     └── 风控限额
  │
  ├── 3. 多腿并行下单
  │     └── Promise.all([
  │           submitOrder(leg1),   // 买 YES
  │           submitOrder(leg2),   // 买 NO
  │         ])
  │
  ├── 4. 订单状态追踪
  │     ├── 全部成交 → 记录利润
  │     ├── 部分成交 → 展开处理
  │     └── 失败 → 撤销已成交部分
  │
  └── 5. 指标记录
        ├── 执行延迟
        ├── 成交比例
        └── 实际利润 vs 预期利润
```

### 6.2 风控系统

**文件**：`src/execution/risk-manager.ts`

| 控制项 | 默认值 | 说明 |
|--------|--------|------|
| 最大日亏损 | $1,000 | 超过后停止交易 |
| 最大总敞口 | $10,000 | 所有持仓的总价值上限 |
| 紧急止损 | $500 | 未实现亏损达到此值触发熔断 |
| 最大单仓占比 | 50% | 单个市场最大仓位占订单簿比例 |
| 最大并发交易 | 5 | 同时进行的交易数 |
| 滑点容忍度 | 2% | 超过后拒绝下单 |

**熔断机制**：

```
正常交易 ──日亏损 > MAX_DAILY_LOSS──▶ 停止新开仓
正常交易 ──未实现亏损 > EMERGENCY──▶ 紧急停止 + 平仓
```

### 6.3 订单管理

**文件**：`src/execution/order-manager.ts`

追踪订单生命周期：`pending → submitted → filled / partially_filled / cancelled / failed`

自动清理超过 1 小时的陈旧订单。

---

## 7. 策略系统

### 7.1 架构

采用 **插件式策略架构**，所有策略继承基类接口：

```typescript
// src/strategies/base.ts
interface TradeSignal {
  type: 'buy' | 'sell' | 'hold';
  marketId: string;
  size: number;
  price: number;
  confidence: number;     // 0-1 信号置信度
  reason: string;          // 人类可读的理由
}

abstract class BaseStrategy {
  abstract analyze(data: StrategyMarketData[]): TradeSignal | null;
}
```

### 7.2 已实现策略

| 策略 | 文件 | 原理 |
|------|------|------|
| **单市场套利** | `simple-arbitrage.ts` | YES + NO ≠ $1 时买入便宜侧 |
| **跨市场套利** | `cross-market-arbitrage.ts` | KL 散度检测多市场价格不一致 |
| **做市** | `market-making.ts` | 在买卖盘两侧挂单赚价差 |
| **趋势跟踪** | `trend-following.ts` | 基于动量指标的方向性交易 |

### 7.3 策略管理器与信号聚合

**文件**：`src/strategies/strategy-manager.ts`、`src/strategies/signal-aggregation.ts`

策略管理器同时运行多个策略，通过信号聚合得出最终决策：

```
策略 A → Signal(buy, 0.8)  ──┐
策略 B → Signal(buy, 0.6)  ──┼── 聚合器 ──▶ 最终信号
策略 C → Signal(hold, 0.3) ──┘

聚合模式：
  - consensus：多数同意才执行
  - priority：优先级最高的策略决定
  - weighted：加权平均置信度
```

---

## 8. API 集成

### 8.1 REST 客户端

**文件**：`src/api/polymarket-client.ts`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/markets` | GET | 获取活跃/关闭的市场列表 |
| `/markets/:id` | GET | 获取单个市场详情 |
| `/orders` | POST | 下单 |
| `/orders/:id` | DELETE | 撤单 |
| `/orders/open` | GET | 查询挂单 |
| `/account/balance` | GET | 查询余额 |
| `/trades` | GET | 交易历史 |
| `/health` | GET | 健康检查 |

**认证方式**：

```
Header: Authorization: Bearer <API_KEY>
可选附加: X-Timestamp, X-Passphrase（HMAC 签名）
```

**错误处理**：自动处理 401（认证失败）、403（权限不足）、429（限流）、5xx（服务端错误）。

### 8.2 WebSocket 客户端

**文件**：`src/api/polymarket-ws.ts`

订阅类型：
- `trades` — 实时成交
- `orderbook` — 订单簿快照/增量更新
- `price_change` — 价格变动

连接特性：
- 指数退避自动重连（最大 60s 间隔）
- 心跳维持（30s ping/pong）
- 支持按市场 ID 订阅/取消订阅

---

## 9. 链上只读对账

旧的区块链交易追踪器与真实 CLOB 下单路径完全断开，已经删除。当前链上代码只做只读运营对账，不广播交易。

### 9.1 Polygon 余额读取

**文件**：`src/execution/onchain-balance-reader.ts`

- 强制校验 Polygon 主网 chain id 137
- 从官方 pUSD ERC-20 合约读取抵押品余额
- 从官方 CTF ERC-1155 合约读取 outcome token 余额
- 全部调用均为 `view`，不签名、不广播交易

### 9.2 三方运营对账

**文件**：`src/execution/operator-readiness-audit.ts`、`src/scripts/operator-readiness-audit.ts`

```
CLOB 余额 ─┐
UI 人工证据 ├─→ 原子单位逐项比较 → Canary readiness 报告
链上余额 ──┘
```

真实 Canary 仍需操作员明确开启三重开关；跨市场多腿因 CLOB 无原子成交能力继续硬拒绝。

---

## 10. 基础设施

### 10.1 配置管理

**文件**：`src/utils/config.ts`、`src/utils/config-schema.ts`

使用 **Zod** 进行运行时校验，所有环境变量通过 schema 解析后导出为强类型配置对象：

```typescript
// 导出的配置组
ALGORITHM_CONFIG   // ALPHA, MAX_ITERATIONS, MIN_PROFIT_THRESHOLD, ...
TRADING_CONFIG     // MAX_POSITION_PCT, SLIPPAGE_TOLERANCE, ...
NETWORK_CONFIG     // POLYGON_RPC_URL, WS_URL, CLOB credentials, ...
WALLET_CONFIG      // WALLET_ADDRESS
LOG_CONFIG         // LOG_LEVEL, STRUCTURED_LOGGING, SILENT
KELLY_CONFIG       // KELLY_FRACTION, MIN_PROBABILITY, MAX_BET_FRACTION
RISK_CONFIG        // MAX_EXPOSURE, MAX_DAILY_LOSS, EMERGENCY_STOP_THRESHOLD
```

环境变量缺失时 Zod 会给出清晰的错误信息，支持默认值。

### 10.2 日志

**文件**：`src/utils/logger.ts`

- JSON 结构化输出（生产环境）或人类可读格式（开发环境）
- 支持子 Logger（携带上下文信息）
- 级别：debug / info / warn / error
- 静默模式（测试环境）

### 10.3 指标与监控

**文件**：`src/utils/metrics.ts`、`src/utils/metric-registry.ts`

Prometheus 风格指标：

| 指标类型 | 示例 |
|---------|------|
| Counter | 订单提交数、套利机会发现数 |
| Gauge | 当前持仓、未实现盈亏 |
| Histogram | 订单延迟、算法迭代次数 |

### 10.4 告警

**文件**：`src/alerts/alert-notification-service.ts`

多渠道告警：

| 渠道 | 用途 |
|------|------|
| Slack | 日常通知、套利发现 |
| Discord | 交易执行结果 |
| Email | 重要事件摘要 |
| PagerDuty | 紧急告警（熔断触发等） |

功能：告警去重（5 分钟窗口）、按严重级别路由、多渠道并发发送。

### 10.5 优雅关闭

**文件**：`src/lifecycle/shutdown.ts`

分阶段关闭序列：

```
信号（SIGTERM/SIGINT/SIGHUP）
  │
  ├── Phase 1：暂停交易（停止新检测周期）
  ├── Phase 2：撤销挂单（10s 超时）
  ├── Phase 3：关闭连接（WebSocket、RPC，5s 超时）
  ├── Phase 4：持久化状态（5s 超时）
  └── Phase 5：强制退出（总超时 30s）
```

按组件优先级排序关闭，高优先级组件先关。

### 10.6 依赖注入

**文件**：`src/di/container.ts`

轻量级 DI 容器，支持：
- 单例注册（`registerSingleton`）
- 瞬态注册（`registerTransient`）
- 令牌解析（`resolve`）
- 父子容器继承

---

## 11. 测试架构

### 11.1 配置

- **框架**：Jest 30.2 + ts-jest
- **环境**：Node.js
- **模式**：`**/tests/**/*.test.ts`
- **覆盖率阈值**：50%（实际 93%+）
- **并行度**：2 worker
- **内存限制**：512MB idle

### 11.2 测试结构

```
tests/
├── core/           # 算法测试（Frank-Wolfe、多面体、Bregman）
├── market/         # 市场数据测试（订单簿、套利检测）
├── execution/      # 执行测试（引擎、订单管理、风控）
├── optimization/   # 求解器测试（LP、IP）
├── strategies/     # 策略测试
├── integration/    # 集成测试（全系统、API、数据管线）
├── utils/          # 工具测试（配置、指标、日志）
├── alerts/         # 告警测试
├── di/             # DI 容器测试
└── security/       # 安全模块测试
```

### 11.3 测试隔离

每个单例组件都暴露 `reset()` 方法：

```typescript
resetDataPipeline()
resetArbitrageDetector()
resetExecutionEngine()
resetRiskManager()
resetMetricsRegistry()
resetTradingSystem()
```

配合 `beforeEach`/`afterEach` 使用，确保测试间无状态泄漏。

### 11.4 模拟模式

`ExecutionEngine` 支持无 API 客户端运行（模拟模式）：
- 95% 模拟成交率
- ±0.5% 价格滑点模拟
- 适用于策略回测和集成测试

---

## 12. 部署

### 12.1 Docker 多阶段构建

```dockerfile
# Stage 1: Builder
FROM node:20-alpine AS builder
# 编译 TypeScript、安装全部依赖

# Stage 2: Production
FROM node:20-alpine
# 仅复制 dist/ 和 production 依赖
# 非 root 用户运行
# 健康检查配置
```

### 12.2 Docker Compose 服务

| 服务 | Profile | 说明 |
|------|---------|------|
| `trading-bot` | 默认 | 交易系统主服务 |
| `trading-bot-dev` | 默认 | 开发环境（挂载源码） |
| `redis` | `with-redis` | 可选缓存层 |
| `prometheus` | `monitoring` | 指标采集 |
| `grafana` | `monitoring` | 可视化仪表板 |

### 12.3 构建与运行

```bash
# 本地开发
npm run dev          # TypeScript 监听编译
npm run test         # 运行测试
npm run typecheck    # 类型检查

# Docker 部署
docker compose up -d                           # 基本服务
docker compose --profile monitoring up -d       # 含监控
docker compose --profile with-redis up -d       # 含 Redis
```

---

## 13. 性能优化

### 13.1 内存优化

**Float64Array 对象池化**（`src/core/frank-wolfe.ts`）：

Frank-Wolfe 迭代中频繁创建/销毁向量。系统使用 `Float64Array` 池避免 GC 压力：

```typescript
// 从池中获取向量（避免 new Float64Array）
const vec = pool.acquire(dimension);
// 使用完归还
pool.release(vec);
```

**稀疏约束存储**（`src/core/bregman-projection.ts`）：

约束矩阵中大量系数为 0，仅存储非零项，节省 60%+ 内存。

### 13.2 数据结构优化

**SkipList 订单簿**（`src/market/skip-list.ts`）：

相比排序数组，SkipList 在频繁插入/删除场景下快约 10 倍：

| 操作 | 排序数组 | SkipList |
|------|---------|----------|
| 插入 | O(n) | O(log n) |
| 删除 | O(n) | O(log n) |
| 查找最值 | O(1) | O(1) |
| 范围查询 | O(log n + k) | O(log n + k) |

### 13.3 算法性能基准

| 操作 | 平均耗时 |
|------|---------|
| Frank-Wolfe 2D（50 次迭代） | 0.10ms |
| Frank-Wolfe 5D（100 次迭代） | 0.28ms |
| LMO 线性规划（5D） | < 0.01ms |
| 订单簿最优价查询 | 0.001ms |
| VWAP 计算 | 0.001ms |
| 订单更新 | 0.0002ms |

---

## 14. 安全实践

### 14.1 密钥管理

- 所有敏感信息存放于 `.env` 文件
- `.env` 已加入 `.gitignore`
- 提供 `.env.example` 模板（不含真实值）
- 运行时通过 `process.env` 读取，Zod 校验完整性
- 支持配置加密（`src/utils/config-encryption.ts`）

### 14.2 API 安全

**文件**：`src/security/api-security.ts`

- API 密钥注册与轮换
- HMAC 请求签名
- 按端点限流
- 交易模式异常检测

### 14.3 输入校验

- 所有配置：Zod schema 运行时校验
- LP/IP 求解器：输入维度和数值校验
- 概率值：范围检查 [0, 1]
- 价格和数量：非负检查

### 14.4 运行时防护

- 未捕获异常和未处理 Promise 拒绝的全局处理
- 信号处理器（SIGINT/SIGTERM/SIGHUP）
- 组件健康检查
- 超时保护（网络、执行、关闭各阶段）

---

## 附录：关键文件速查

| 文件 | 说明 |
|------|------|
| `src/index.ts` | 主入口，`PolymarketTradingSystem` 类 |
| `src/core/frank-wolfe.ts` | 核心优化算法 |
| `src/core/marginal-polytope.ts` | 可行域定义 |
| `src/core/bregman-projection.ts` | Bregman 投影 |
| `src/market/arbitrage-detector.ts` | 套利检测引擎 |
| `src/market/data-pipeline.ts` | WebSocket 数据管线 |
| `src/market/order-book.ts` | 订单簿实现 |
| `src/execution/execution-engine.ts` | 执行引擎 |
| `src/execution/risk-manager.ts` | 风控系统 |
| `src/execution/position-sizing.ts` | Kelly 仓位计算 |
| `src/strategies/strategy-manager.ts` | 策略编排 |
| `src/api/polymarket-client.ts` | REST API 客户端 |
| `src/api/polymarket-ws.ts` | WebSocket 客户端 |
| `src/utils/config.ts` | 配置中心 |
| `src/lifecycle/shutdown.ts` | 优雅关闭 |
