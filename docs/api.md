# API 文档

## PolymarketTradingSystem

主交易系统类，集成所有组件。

### 构造函数

```typescript
new PolymarketTradingSystem(config: TradingSystemConfig)
```

**参数:**
- `config.liveTrading`: `boolean` - 是否启用实盘交易
- `config.markets`: `string[]` - 监控的市场 ID 列表
- `config.events`: `Array<{id: string, markets: Array<{id: string, outcome: 'YES' | 'NO', price: number}>}>` - 事件配置

**示例:**
```typescript
const system = new PolymarketTradingSystem({
  liveTrading: false,
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
});
```

### 方法

#### initialize()

初始化交易系统。

```typescript
await system.initialize(): Promise<void>
```

**功能:**
- 验证配置
- 初始化日志系统
- 设置事件处理器
- 添加事件到检测器

#### start()

启动交易系统。

```typescript
await system.start(): Promise<void>
```

**功能:**
- 连接数据管道
- 启动主循环
- 开始套利检测

#### stop()

停止交易系统。

```typescript
await system.stop(): Promise<void>
```

**功能:**
- 断开数据管道
- 取消事件订阅
- 清理资源

#### runDetectionCycle()

运行单次套利检测循环。

```typescript
await system.runDetectionCycle(): Promise<ArbitrageOpportunity[]>
```

**返回:** 检测到的套利机会数组

**示例:**
```typescript
const opportunities = await system.runDetectionCycle();
console.log(`发现 ${opportunities.length} 个套利机会`);
```

#### executeOpportunity()

执行套利机会。

```typescript
await system.executeOpportunity(opportunity: ArbitrageOpportunity): Promise<boolean>
```

**参数:**
- `opportunity`: 套利机会对象

**返回:** 是否执行成功

---

## ArbitrageDetector

套利检测器，检测市场中的套利机会。

### 方法

#### addEvent()

添加事件到检测器。

```typescript
addEvent(event: TradingEvent): void
```

**参数:**
- `event.id`: 事件 ID
- `event.markets`: 市场列表
- `event.outcomes`: 结果列表

#### updatePrice()

更新市场价格。

```typescript
updatePrice(marketId: string, price: number): void
```

#### findAllOpportunities()

查找所有套利机会。

```typescript
findAllOpportunities(): ArbitrageOpportunity[]
```

**返回:** 套利机会数组

---

## ExecutionEngine

交易执行引擎。

### 方法

#### setApiClient()

设置 API 客户端。

```typescript
setApiClient(client: PolymarketClient): void
```

#### executeOrder()

执行单个订单。

```typescript
await executeOrder(order: TradeOrder): Promise<OrderStatus>
```

#### executeParallel()

并行执行多个订单。

```typescript
await executeParallel(orders: TradeOrder[]): Promise<ExecutionResult>
```

#### executeArbitrage()

执行多腿套利交易。

```typescript
await executeArbitrage(legs: TradeLeg[], arbitrageId: string): Promise<ExecutionResult>
```

#### cancelOrder()

取消订单。

```typescript
await cancelOrder(orderId: string): Promise<boolean>
```

---

## RiskManager

风险管理器。

### 方法

#### checkTrade()

检查交易是否允许。

```typescript
checkTrade(
  marketId: string,
  size: number,
  side: 'buy' | 'sell',
  estimatedNotional: number
): RiskCheckResult
```

**返回:**
- `allowed`: 是否允许
- `reason`: 拒绝原因（如果不允许）

#### checkEmergencyStop()

检查是否触发紧急停止。

```typescript
checkEmergencyStop(): boolean
```

#### updatePosition()

更新仓位。

```typescript
updatePosition(marketId: string, size: number, side: 'buy' | 'sell'): void
```

---

## 核心算法

### frankWolfe()

Frank-Wolfe 优化算法。

```typescript
frankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[] | Float64Array) => number,
  gradientFn: (mu: number[] | Float64Array) => number[],
  lmoFn: (grad: number[] | Float64Array) => number[],
  options?: FrankWolfeOptions
): FrankWolfeResult
```

**参数:**
- `initialMu`: 初始点
- `objectiveFn`: 目标函数
- `gradientFn`: 梯度函数
- `lmoFn`: 线性最小化 oracle
- `options.maxIterations`: 最大迭代次数
- `options.tolerance`: 收敛阈值
- `options.stepSize`: 步长策略 (`line-search` | `adaptive`)
  - `line-search`: 沿 `mu -> s` 线段对真实目标函数做 golden-section 搜索

**返回:**
- `mu`: 最优解
- `objective`: 目标值
- `gap`: Frank-Wolfe 间隙
- `iterations`: 迭代次数
- `converged`: 是否收敛

### lineSearchObjective()

对 Frank-Wolfe 线段方向执行目标函数线搜索。

```typescript
lineSearchObjective(
  mu: number[],
  s: number[],
  objectiveFn: (candidate: number[]) => number,
  maxIterations?: number
): number
```

**返回:**
- `gamma`: 区间 `[0, 1]` 内的步长

### bregmanProjection()

Bregman 投影算法。

```typescript
bregmanProjection(
  priceVector: number[],
  constraints: Constraint[],
  maxIterations?: number,
  tolerance?: number
): BregmanProjectionResult
```

**参数:**
- `priceVector`: 价格向量
- `constraints`: 约束条件
- `maxIterations`: 最大迭代次数
- `tolerance`: 收敛阈值

**返回:**
- `projection`: 投影点
- `divergence`: KL 散度
- `iterations`: 迭代次数
- `converged`: 是否收敛

> 注：跨市场套利模块在未归一化向量场景使用广义 KL 散度  
> `D(p||q) = Σ [ p_i log(p_i/q_i) - p_i + q_i ]`

---

## 类型定义

### ArbitrageOpportunity

```typescript
interface ArbitrageOpportunity {
  id: string;
  type: 'single-market' | 'cross-market';
  markets: string[];
  guaranteedProfit: number;
  confidence: number;
  tradeDirection: number[];
  timestamp: number;
}
```

### TradeOrder

```typescript
interface TradeOrder {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}
```

### OrderStatus

```typescript
interface OrderStatus {
  orderId: string;
  status: 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'error';
  filledSize: number;
  remainingSize: number;
  avgPrice: number;
  timestamp: number;
  error?: string;
}
```

### RiskCheckResult

```typescript
interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}
```

---

## 错误处理

所有异步方法都可能抛出错误。建议使用 try-catch 处理：

```typescript
try {
  await system.executeOpportunity(opportunity);
} catch (error) {
  if (error instanceof ApiError) {
    console.error('API 错误:', error.message);
  } else if (error instanceof RiskError) {
    console.error('风险检查失败:', error.message);
  } else {
    console.error('未知错误:', error);
  }
}
```

## 事件监听

### DataPipeline 事件

```typescript
import { getDataPipeline } from './src/market/data-pipeline.js';

const pipeline = getDataPipeline();

// 订阅市场数据
const unsubscribe = pipeline.subscribe((event) => {
  switch (event.type) {
    case 'trade':
      console.log('交易:', event.data);
      break;
    case 'orderbook':
      console.log('订单簿更新:', event.data);
      break;
    case 'connected':
      console.log('已连接');
      break;
    case 'disconnected':
      console.log('已断开');
      break;
    case 'error':
      console.error('错误:', event.error);
      break;
  }
});

// 取消订阅
unsubscribe();
```
