# Polymarket 套利交易系统

[English (Default)](./README.md) | [中文](./README.zh-CN.md)

基于边际多面体（Marginal Polytope）和 Frank-Wolfe 优化算法的套利研究与模拟交易系统。

## 项目状态

[![CI](https://github.com/signorloops/polymarket-trading/actions/workflows/ci.yml/badge.svg)](https://github.com/signorloops/polymarket-trading/actions/workflows/ci.yml)
[![Security](https://github.com/signorloops/polymarket-trading/actions/workflows/security.yml/badge.svg)](https://github.com/signorloops/polymarket-trading/actions/workflows/security.yml)

- ✅ **代码质量**: ESLint 0 错误，TypeScript 严格模式
- ✅ **自动化验证**：CI 执行类型检查、lint、格式、死代码检查、测试、构建和冒烟测试
- ✅ **性能工具**：提供数学、优化器和订单簿路径的独立基准测试
- ✅ **文档完善**: API 文档、架构说明、部署指南

## 核心特性

- **可审计机会检测**：单市场机会使用新鲜订单簿深度与费用；跨市场美元机会必须配置穷尽的 payoff 场景
- **Bregman 投影**：使用 KL / 广义 KL 散度计算最优交易向量
- **Frank-Wolfe 算法**：真实目标线搜索（golden-section）+ 约束可行迭代更新
- **实时数据处理**：WebSocket 数据管道，订单簿重建（SkipList O(log n)）
- **优化求解器升级**：LP/MILP 使用 `javascript-lp-solver` 后端并做可行性校验
- **风险管理**：熔断机制、仓位限制、部分成交处理
- **高性能**: Float64Array 内存池，稀疏约束处理

## 系统架构

```
src/
├── core/                    # 核心算法
│   ├── marginal-polytope.ts # 边际多面体计算
│   ├── bregman-projection.ts # Bregman 投影
│   ├── frank-wolfe.ts       # Frank-Wolfe 算法
│   └── init-fw.ts           # 初始化算法
├── market/                  # 市场数据处理
│   ├── data-pipeline.ts     # WebSocket 数据管道
│   ├── order-book.ts        # 订单簿分析
│   ├── arbitrage-detector.ts # 套利检测器
│   └── dependency-graph.ts  # 市场依赖关系图
├── execution/               # 交易执行
│   ├── execution-engine.ts  # 执行引擎
│   ├── position-sizing.ts   # 仓位计算
│   └── risk-manager.ts      # 风险管理
├── optimization/            # 优化求解器
│   ├── lp-solver.ts         # 线性规划求解器
│   └── ip-solver.ts         # 整数规划求解器
└── utils/                   # 工具函数
    ├── math.ts              # 数学工具
    ├── logger.ts            # 日志系统
    └── config.ts            # 配置管理
```

## 安装

```bash
# 克隆仓库
git clone <repository-url>
cd polymarket-trading

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件添加你的 API 密钥和配置
```

## 配置

在 `.env` 文件中配置以下参数：

```env
# 网络配置
RPC_URL= # 可选的旧 Polygon 交易追踪器
WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_api_secret
POLYMARKET_PASSPHRASE=your_api_passphrase
POLYMARKET_CHAIN_ID=137
POLYMARKET_SIGNATURE_TYPE=0 # 0=EOA, 1=代理钱包, 2=Gnosis Safe, 3=EIP-1271
POLYMARKET_FUNDER_ADDRESS=

# 钱包配置
PRIVATE_KEY= # 已有签名 CLOB 适配层；实盘编排默认仍禁用
WALLET_ADDRESS=your_wallet_address

# 算法参数
ALPHA=0.9
INITIAL_EPSILON=0.1
MAX_ITERATIONS=150
MIN_PROFIT_THRESHOLD=0.05 # 无量纲 KL 诊断阈值，不是美元利润

# 交易参数
MAX_POSITION_PCT=0.5
SLIPPAGE_TOLERANCE=0.02
MAX_CONCURRENT_TRADES=5

# 风险管理
MAX_DAILY_LOSS=1000
MAX_EXPOSURE=10000
EMERGENCY_STOP_THRESHOLD=500
```

## 手动 Canary 交易

`npm run canary:trade` 是单笔 canary 入口。默认 dry-run，不会启用自动实盘交易。

真实提交必须同时设置所有闸门：

```env
CANARY_TOKEN_ID=1234567890
CANARY_SIDE=buy
CANARY_SIZE=1
CANARY_PRICE=0.01
CANARY_MAX_NOTIONAL_USD=5
CANARY_DRY_RUN=false
CANARY_TRADING_ENABLED=true
CANARY_CONFIRMATION=PLACE_ONE_REAL_POLYMARKET_CANARY_ORDER
CANARY_STATE_PATH=.state/canary-trades.json
CANARY_KILL_SWITCH_PATH=.state/canary-kill-switch.json
```

canary CLI 会在提交前持久化意图，并对不确定提交结果安全失败。kill-switch 文件缺失时真实提交也会被阻止；只有在已审核的 canary 窗口内，才应显式执行 `npm run canary:kill-switch -- deactivate`。预检要求客户端支持订单状态、余额/授权额与 heartbeat。部分成交、完全成交和不确定结果都会标记为需要人工对账。
`npm run canary:kill-switch -- activate "reason"` 会阻止后续真实 canary 提交；`npm run canary:cancel-all` 会基于持久化状态文件尝试撤掉所有未终态 canary 订单。

自动实盘仍保持禁用。Canary、余额对账、持久幂等、payoff 模型与多腿原子性的状态见 [实盘就绪门禁](docs/live-trading-readiness.md)。

## Runtime Config CLI

用内置模板生成 daemon 配置：

```bash
npm run runtime-config:generate -- ./config/trading-system.json
```

启动前校验 daemon 配置：

```bash
npm run runtime-config:validate -- ./config/trading-system.json
```

发布前可以对构建后的 daemon 进程和 Docker 镜像做一次冒烟验证：

```bash
npm run smoke:daemon
npm run smoke:docker
```

## 使用

### 基础用法

```typescript
import { PolymarketTradingSystem } from './src/index.js';

const config = {
  liveTrading: false, // 当前有安全保护，暂不支持实盘交易
  markets: [],
  events: [
    {
      id: 'event-1',
      markets: [
        { id: 'market-yes', outcome: 'YES', price: 0.6 },
        { id: 'market-no', outcome: 'NO', price: 0.4 },
      ],
    },
  ],
};

const system = new PolymarketTradingSystem(config);
system.initialize();
system.start();
```

### 运行检测循环

```typescript
// 运行单次套利检测
const opportunities = system.runDetectionCycle();
console.log(`发现 ${opportunities.length} 个套利机会`);

// 执行套利机会
for (const opp of opportunities) {
  if (opp.guaranteedProfit > 0.05) {
    system.executeOpportunity(opp);
  }
}
```

## 核心算法

### Frank-Wolfe 优化

```typescript
import { frankWolfe, linearMinimizationOracle } from './src/core/frank-wolfe.js';

const result = frankWolfe(
  initialPoint,
  objectiveFn, // 目标函数（如 KL 散度）
  gradientFn, // 梯度函数
  lmoFn, // 线性最小化 oracle
  { maxIterations: 150, tolerance: 1e-6 }
);

console.log(`最优解: ${result.mu}`);
console.log(`目标值: ${result.objective}`);
console.log(`间隙: ${result.gap}`);
```

### 近期算法改进（2026-02-20）

- **Frank-Wolfe 可行性修复**：移除迭代内全局 simplex 投影，避免破坏多事件独立等式组约束。
- **步长策略升级**：`line-search` 改为沿 `mu -> s` 线段对真实目标做 golden-section 搜索。
- **Barrier 收敛判据修复**：收敛条件显式包含 `tolerance`，避免“未达阈值提前收敛”。
- **跨市场约束一致性**：`MarketDependencyGraph.addMarket()` 自动补全事件节点，保证构造约束矩阵时事件约束不丢失。
- **跨市场目标函数修正**：跨市场策略和检测器统一使用广义 KL（适配未归一化非负向量）。
- **订单簿性能路径优化**：`OrderBook` 使用 SkipList 维护价位顺序 + 增量维护深度，最佳买卖价 O(1) 查询。
- **求解器能力升级**：`LP/IP` 接口接入 `javascript-lp-solver`，同时保留输入校验、可行性校验和分支定界回退路径。

### Bregman 投影

```typescript
import { bregmanProjection } from './src/core/bregman-projection.js';

const result = bregmanProjection(
  priceVector, // 当前市场价格
  constraints, // 多面体约束
  maxIterations,
  tolerance
);

console.log(`投影: ${result.projection}`);
console.log(`散度: ${result.divergence}`);
```

### 仓位计算

```typescript
import { calculatePositionSize } from './src/execution/position-sizing.js';

const result = calculatePositionSize({
  probability: 0.6, // 获胜概率
  price: 0.5, // 市场价格
  capital: 10000, // 可用资金
  orderBook, // 订单簿
  side: 'buy', // 交易方向
});

console.log(`推荐仓位: ${result.size}`);
console.log(`资金占比: ${result.fraction}`);
```

## 测试

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率报告
npm run test:coverage

# 运行特定测试文件
npm test -- tests/core/frank-wolfe.test.ts
```

## 开发

```bash
# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 格式化代码
npm run format

# 构建项目
npm run build

# 开发模式（监视）
npm run dev
```

## 数学理论

### 边际多面体

边际多面体 M 是有效收益向量的凸包。对于二元事件市场，它编码了概率约束：

```
YES + NO = 1
YES ≥ 0, NO ≥ 0
```

### Bregman 投影

归一化分布场景使用 KL 散度：

```
D_KL(μ || θ) = Σ μ_i * log(μ_i / θ_i)
```

跨市场未归一化向量场景使用广义 KL 散度：

```
D(μ || θ) = Σ [ μ_i * log(μ_i / θ_i) - μ_i + θ_i ]
```

其中 μ 是投影点，θ 是价格向量。

### Frank-Wolfe 算法

迭代更新规则：

```
μ_{t+1} = (1 - γ) * μ_t + γ * s_t
```

其中 s_t 是线性最小化 oracle 返回的顶点，γ 是步长。

### 改良 Kelly 准则

```
f = (b*p - q) / b * sqrt(p)
```

其中：

- f = 资金占比
- b = 赔率
- p = 获胜概率
- q = 1 - p

## 风险提示

**警告**：交易存在风险，可能导致资金损失。

- 本系统提供的交易建议不构成投资建议
- 始终先用纸面交易测试策略
- 了解智能合约风险和非原子执行风险
- 监控滑点和流动性
- 设置适当的止损和仓位限制

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request。

## 性能基准测试

### 算法性能

```
Frank-Wolfe 2D (50 iterations):    0.10ms avg
Frank-Wolfe 5D (100 iterations):   0.28ms avg
Linear Minimization Oracle (5D):   0.00ms avg (100K iterations)
```

### OrderBook 操作 (SkipList 优化)

```
Get best bid/ask:                  0.001ms avg
Get mid price:                     0.003ms avg
Calculate VWAP:                    0.001ms avg
Update order book:                 0.0002ms avg
```

### 内存优化

- **Float64Array 对象池**: 重用缓冲区，减少 GC 压力
- **稀疏约束处理**: 只存储非零系数，内存占用减少 60%+
- **SkipList 数据结构**: O(log n) 插入/删除，比排序数组快 10x

## Docker 部署

### 构建镜像

```bash
docker build -t polymarket-trading .
```

### 运行容器

```bash
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
docker run -d \
  --name polymarket-trading \
  --env-file .env \
  -e HTTP_HOST=0.0.0.0 \
  -e HTTP_METRICS_TOKEN_FILE=/run/secrets/metrics-token \
  -v $(pwd)/config:/app/config:ro \
  -v $(pwd)/.secrets/metrics-token:/run/secrets/metrics-token:ro \
  --mount source=polymarket-state,target=/app/.state \
  -p 127.0.0.1:3000:3000 \
  polymarket-trading
```

### Docker Compose

```bash
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
openssl rand -hex 32 > .secrets/grafana-admin-password
docker compose --profile monitoring up -d
```

包含：

- 交易服务
- Prometheus 监控
- Grafana 仪表盘

## 监控与日志

### Prometheus 指标

- `trading_arbitrage_opportunities_total`: 已记录的机会数
- `trading_orders_submitted_total`: 已提交订单数
- `trading_position_size`: 当前仓位大小
- `trading_position_pnl`: 未实现仓位盈亏
- `trading_total_exposure`: 当前总敞口

### Grafana 仪表盘

交易守护进程接口：

- `http://localhost:3000/health`
- `http://localhost:3000/ready`
- `http://localhost:3000/metrics`（非 loopback 监听时必须使用 Bearer 鉴权）
- `http://localhost:3000/api/risk/status`（仅在配置 `HTTP_RISK_STATUS_TOKEN` 后开放，
  请求需携带 `Authorization: Bearer <token>`）

Grafana 仪表盘：

- `http://localhost:3001`

### 日志级别

```bash
# 开发模式
LOG_LEVEL=debug npm run dev

# 生产模式
npm run build
TRADING_SYSTEM_CONFIG_PATH=./config/trading-system.example.json LOG_LEVEL=warn npm start
```

## 更新日志

### v1.0.0 (2026-02-17)

- ✅ 完成 ESLint 错误修复 (401 → 0)
- ✅ 完成 API 集成 (Polymarket REST + WebSocket)
- ✅ 代码拆分 (frank-wolfe.ts 414行 → 242行)
- ✅ 性能优化 (SkipList, Float64ArrayPool, 稀疏约束)
- ✅ 添加自动化测试和 CI 质量门禁
- ✅ 添加 Docker 支持
- ✅ 添加 Prometheus/Grafana 监控

## API 文档

详见 [docs/api.md](./docs/api.md)

## Mermaid 学习文档

详见 [docs/mermaid-learning-guide.md](./docs/mermaid-learning-guide.md)

## 参考资料

1. "Arbitrage in Prediction Markets" - 边际多面体理论基础
2. "Frank-Wolfe Algorithms for Prediction Market Aggregation"
3. "Bregman Projection for Arbitrage Detection"
