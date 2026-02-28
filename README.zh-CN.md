# Polymarket 套利交易系统

[English (Default)](./README.md) | [中文](./README.zh-CN.md)

基于边际多面体（Marginal Polytope）和 Frank-Wolfe 优化算法的高频套利交易系统。

## 项目状态

[![Tests](https://img.shields.io/badge/tests-942%20passed-brightgreen)]()
[![Coverage](https://img.shields.io/badge/coverage-93%25-brightgreen)]()
[![Lint](https://img.shields.io/badge/lint-passing-brightgreen)]()
[![Build](https://img.shields.io/badge/build-passing-brightgreen)]()

- ✅ **代码质量**: ESLint 0 错误，TypeScript 严格模式
- ✅ **测试覆盖**: 93%+ 语句覆盖，82%+ 分支覆盖，942 个测试
- ✅ **性能优化**: 核心算法微秒级响应
- ✅ **文档完善**: API 文档、架构说明、部署指南

## 核心特性

- **边际多面体套利检测**：通过凸优化检测跨市场套利机会
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
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
WS_URL=wss://ws.polymarket.com
POLYMARKET_API_KEY=your_api_key

# 钱包配置
PRIVATE_KEY=your_private_key
WALLET_ADDRESS=your_wallet_address

# 算法参数
ALPHA=0.9
INITIAL_EPSILON=0.1
MAX_ITERATIONS=150
MIN_PROFIT_THRESHOLD=0.05

# 交易参数
MAX_POSITION_PCT=0.5
SLIPPAGE_TOLERANCE=0.02
MAX_CONCURRENT_TRADES=5

# 风险管理
MAX_DAILY_LOSS=1000
MAX_EXPOSURE=10000
EMERGENCY_STOP_THRESHOLD=500
```

## 使用

### 基础用法

```typescript
import { PolymarketTradingSystem } from './src/index.js';

const config = {
  liveTrading: false, // 设置为 true 开启实盘交易
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
await system.initialize();
await system.start();
```

### 运行检测循环

```typescript
// 运行单次套利检测
const opportunities = await system.runDetectionCycle();
console.log(`发现 ${opportunities.length} 个套利机会`);

// 执行套利机会
for (const opp of opportunities) {
  if (opp.guaranteedProfit > 0.05) {
    await system.executeOpportunity(opp);
  }
}
```

## 核心算法

### Frank-Wolfe 优化

```typescript
import { frankWolfe, linearMinimizationOracle } from './src/core/frank-wolfe.js';

const result = frankWolfe(
  initialPoint,
  objectiveFn,  // 目标函数（如 KL 散度）
  gradientFn,   // 梯度函数
  lmoFn,        // 线性最小化 oracle
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
  priceVector,     // 当前市场价格
  constraints,     // 多面体约束
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
  probability: 0.6,    // 获胜概率
  price: 0.5,          // 市场价格
  capital: 10000,      // 可用资金
  orderBook,           // 订单簿
  side: 'buy',         // 交易方向
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
docker run -d \
  --name polymarket-trading \
  --env-file .env \
  -p 3000:3000 \
  polymarket-trading
```

### Docker Compose

```bash
docker-compose up -d
```

包含：
- 交易服务
- Prometheus 监控
- Grafana 仪表盘

## 监控与日志

### Prometheus 指标

- `arbitrage_opportunities_total`: 检测到的套利机会总数
- `trade_executions_total`: 交易执行次数
- `position_size_usd`: 当前仓位大小
- `pnl_usd`: 累计盈亏
- `risk_manager_status`: 风险管理器状态

### Grafana 仪表盘

访问 `http://localhost:3000` 查看：
- 实时套利机会
- 交易历史
- 风险指标
- 系统性能

### 日志级别

```bash
# 开发模式
LOG_LEVEL=debug npm run dev

# 生产模式
LOG_LEVEL=warn npm start
```

## 更新日志

### v1.0.0 (2026-02-17)

- ✅ 完成 ESLint 错误修复 (401 → 0)
- ✅ 完成 API 集成 (Polymarket REST + WebSocket)
- ✅ 代码拆分 (frank-wolfe.ts 414行 → 242行)
- ✅ 性能优化 (SkipList, Float64ArrayPool, 稀疏约束)
- ✅ 测试覆盖率达到 93%+ (942 个测试)
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
