# TypeScript 教学：从 Python 到 TypeScript

> 本文所有代码示例均取自本项目（Polymarket 套利交易系统）的真实代码。
> 每段代码都标注了源文件路径，你可以直接跳转查看完整上下文。

---

## 目录

1. [核心差异速览](#1-核心差异速览)
2. [环境与项目结构](#2-环境与项目结构)
3. [基础类型](#3-基础类型)
4. [接口与类型别名](#4-接口与类型别名)
5. [联合类型与字面量类型](#5-联合类型与字面量类型)
6. [可选属性与空值处理](#6-可选属性与空值处理)
7. [函数](#7-函数)
8. [泛型](#8-泛型)
9. [类与继承](#9-类与继承)
10. [枚举与常量](#10-枚举与常量)
11. [异步编程](#11-异步编程)
12. [模块系统](#12-模块系统)
13. [错误处理](#13-错误处理)
14. [工具类型](#14-工具类型)
15. [运行时验证（Zod）](#15-运行时验证zod)
16. [实用技巧](#16-实用技巧)

---

## 1. 核心差异速览

| 特性 | Python | TypeScript |
|------|--------|------------|
| 类型系统 | 动态类型，type hints 可选 | 静态类型，编译时检查 |
| 运行环境 | CPython 解释器 | 编译为 JS，运行在 Node.js/浏览器 |
| 空值 | `None` | `null` 和 `undefined` 两种 |
| 包管理 | pip / uv / poetry | npm / pnpm / yarn |
| 异步 | `asyncio`，需要事件循环 | 内置 `Promise`，天然异步 |
| 类型擦除 | type hints 运行时可反射 | 类型编译后完全擦除 |
| 分号 | 不需要 | 可选（推荐加） |
| 缩进 | 强制缩进定义作用域 | 大括号 `{}` 定义作用域 |

**最重要的一点**：TypeScript 的类型在编译后会被完全擦除。这意味着类型只在开发时帮你捕获错误，运行时不存在。如果你需要运行时验证，需要用 Zod 这样的库（见第 15 节）。

---

## 2. 环境与项目结构

### tsconfig.json — TypeScript 编译器配置

Python 没有对应概念。最接近的类比是 `mypy.ini` 或 `pyproject.toml` 中的 mypy 配置。

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2020",              // 编译目标版本（类似 Python 的最低版本要求）
    "module": "NodeNext",            // 模块系统
    "strict": true,                  // 开启所有严格检查（强烈推荐）
    "noUncheckedIndexedAccess": true, // 数组/对象索引访问返回 T | undefined
    "outDir": "./dist",              // 编译输出目录
    "declaration": true              // 生成 .d.ts 类型声明文件
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

> 📁 源文件：`tsconfig.json`

### package.json — 项目配置

等价于 Python 的 `pyproject.toml`。

```jsonc
{
  "name": "polymarket-trading",
  "type": "module",         // 使用 ESM 模块系统（现代标准）
  "scripts": {
    "build": "tsc",          // 编译 TypeScript → JavaScript
    "test": "jest",          // 运行测试
    "typecheck": "tsc --noEmit"  // 只做类型检查，不输出文件
  }
}
```

> 📁 源文件：`package.json`

**类比**：
- `npm install` ≈ `pip install` / `uv sync`
- `npm run build` ≈ 无直接对应（Python 不需要编译步骤）
- `npm test` ≈ `pytest`
- `node_modules/` ≈ `.venv/`

---

## 3. 基础类型

### Python vs TypeScript 类型注解

```python
# Python
name: str = "hello"
count: int = 42
price: float = 3.14
active: bool = True
items: list[str] = ["a", "b"]
mapping: dict[str, int] = {"a": 1}
```

```typescript
// TypeScript
const name: string = "hello";
let count: number = 42;       // TS 没有 int/float 之分，统一为 number
const price: number = 3.14;
const active: boolean = true;
const items: string[] = ["a", "b"];
const mapping: Record<string, number> = { a: 1 };
```

**关键差异**：
- TypeScript 用 `number` 统一表示整数和浮点数（底层都是 64 位浮点）
- `const` = 不可重新赋值（类似 Python 的常量约定），`let` = 可变
- 不用 `var`（历史遗留，有作用域问题）

### 类型推断

TypeScript 有强大的类型推断，大多数时候不需要手动标注：

```typescript
const name = "hello";    // 自动推断为 string
const count = 42;        // 自动推断为 number
const items = ["a", "b"]; // 自动推断为 string[]
```

Python 的 mypy 也能推断，但 TypeScript 的推断更强大、更普遍。

---

## 4. 接口与类型别名

这是 TypeScript 最核心的概念之一。接口（interface）定义对象的"形状"。

### interface — 定义对象结构

```typescript
// src/execution/types.ts

export interface TradeOrder {
  id: string;
  marketId: string;
  side: 'buy' | 'sell';        // 字面量联合类型，只能是这两个值
  size: number;
  price: number;
  orderType: 'limit' | 'market';
  timeInForce?: 'GTC' | 'IOC' | 'FOK';  // ? 表示可选属性
}

export interface OrderStatus {
  orderId: string;
  status: 'pending' | 'open' | 'filled' | 'partial' | 'cancelled' | 'error';
  filledSize: number;
  remainingSize: number;
  avgPrice: number;
  timestamp: number;
  error?: string;              // 可选：只有出错时才有
}
```

> 📁 源文件：`src/execution/types.ts`

**Python 对比**：

```python
# Python 等价写法
from dataclasses import dataclass
from typing import Optional, Literal

@dataclass
class TradeOrder:
    id: str
    market_id: str
    side: Literal['buy', 'sell']
    size: float
    price: float
    order_type: Literal['limit', 'market']
    time_in_force: Optional[Literal['GTC', 'IOC', 'FOK']] = None

# 或者用 TypedDict（更接近 TS interface，只约束结构不约束行为）
from typing import TypedDict

class TradeOrder(TypedDict, total=False):
    id: str
    market_id: str
    side: Literal['buy', 'sell']
    # ...
```

**核心区别**：
- TypeScript 的 interface 是"结构类型"（structural typing）：只要对象的形状匹配就行，不需要显式继承
- Python 的 dataclass 是"名义类型"（nominal typing）：必须是该类的实例

```typescript
// 这在 TypeScript 中完全合法——不需要 new TradeOrder()
const order: TradeOrder = {
  id: "001",
  marketId: "market-1",
  side: "buy",
  size: 100,
  price: 0.65,
  orderType: "limit",
};
```

### type — 类型别名

`type` 可以给任何类型起别名，比 `interface` 更灵活：

```typescript
// src/utils/logger.ts:7
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// src/execution/canary-trade-persistence.ts
export type CanaryTradeRecordStatus =
  | 'dry-run'
  | 'submitted'
  | 'open'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'unknown';
```

**何时用 interface vs type**：
- `interface`：定义对象结构（可以被扩展、合并）
- `type`：联合类型、交叉类型、简单别名、所有其他情况

---

## 5. 联合类型与字面量类型

### 联合类型（Union Types）

```typescript
// src/api/polymarket-ws.ts:28-31 — 标签联合类型（Discriminated Union）
export type WsMessage =
  | { type: 'trade'; data: WsTrade }
  | { type: 'orderbook'; data: WsOrderBookUpdate }
  | { type: 'price'; data: { marketId: string; price: string; timestamp: string } };
```

> 📁 源文件：`src/api/polymarket-ws.ts`

这是一个**标签联合类型**（discriminated union），通过 `type` 字段区分不同的消息类型。TypeScript 能根据 `type` 的值自动推断 `data` 的类型：

```typescript
function handleMessage(msg: WsMessage) {
  switch (msg.type) {
    case 'trade':
      // TypeScript 知道这里 msg.data 是 WsTrade 类型
      console.log(msg.data.price);
      break;
    case 'orderbook':
      // TypeScript 知道这里 msg.data 是 WsOrderBookUpdate 类型
      console.log(msg.data.bids);
      break;
    case 'price':
      // TypeScript 知道这里 msg.data 有 marketId, price, timestamp
      console.log(msg.data.marketId);
      break;
  }
}
```

**Python 对比**：

```python
# Python 3.10+ 用 match/case
from typing import Union
from dataclasses import dataclass

@dataclass
class TradeMsg:
    type: Literal['trade']
    data: WsTrade

@dataclass
class OrderBookMsg:
    type: Literal['orderbook']
    data: WsOrderBookUpdate

WsMessage = Union[TradeMsg, OrderBookMsg]

# 但 Python 的 match/case 不会自动缩窄类型
```

标签联合是 TypeScript 中最强大的模式之一，Python 目前没有完全对等的能力。

---

## 6. 可选属性与空值处理

TypeScript 有 `null` 和 `undefined` 两种"空值"，Python 只有 `None`。

### 可选属性 `?`

```typescript
// src/execution/types.ts:17
export interface TradeOrder {
  // ...
  timeInForce?: 'GTC' | 'IOC' | 'FOK';  // 可选，类型是 'GTC' | 'IOC' | 'FOK' | undefined
}
```

等价于 Python 的：

```python
time_in_force: Optional[Literal['GTC', 'IOC', 'FOK']] = None
```

### 空值合并运算符 `??`

```typescript
// src/api/polymarket-ws.ts:48
this.url = url ?? NETWORK_CONFIG.WS_URL;
// 如果 url 是 null 或 undefined，使用右边的值
```

Python 没有 `??`，需要用 `or`（但 `or` 对 `0`、`""` 也会触发）：

```python
# Python（注意：or 对 0/"" 也会 fallback）
self.url = url or NETWORK_CONFIG["WS_URL"]

# 更精确的等价写法
self.url = url if url is not None else NETWORK_CONFIG["WS_URL"]
```

### 可选链 `?.`

```typescript
// 安全地访问可能为 null/undefined 的属性
config.method?.toUpperCase()   // 如果 method 是 undefined，整个表达式返回 undefined

// 等价的冗长写法
config.method !== undefined ? config.method.toUpperCase() : undefined
```

Python 没有可选链，需要手写：

```python
config.method.upper() if config.method is not None else None
```

### 空值合并赋值 `??=`

```typescript
// src/utils/singleton.ts:9
instance ??= factory();
// 等价于：if (instance === null || instance === undefined) instance = factory();
```

Python 没有 `??=`，最接近的是 `walrus` 运算符或条件赋值。

---

## 7. 函数

### 基本函数定义

```typescript
// src/utils/errors.ts
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

> 📁 源文件：`src/utils/errors.ts`

**Python 对比**：

```python
def get_error_message(error: object) -> str:
    return error.message if isinstance(error, Exception) else str(error)
```

### 默认参数 + 解构

```typescript
// src/core/frank-wolfe.ts:101-115
export function frankWolfe(
  initialMu: number[],
  objectiveFn: (mu: number[] | Float64Array) => number,  // 函数类型参数
  gradientFn: (mu: number[] | Float64Array) => number[],
  lmoFn: (grad: number[] | Float64Array) => number[],
  options: FrankWolfeOptions = {}                         // 默认值为空对象
): FrankWolfeResult {
  // 解构 + 默认值
  const {
    maxIterations = 150,
    tolerance = 1e-6,
    stepSize = 'line-search',
    verbose = false,
  } = options;
  // ...
}
```

> 📁 源文件：`src/core/frank-wolfe.ts`

注意 `objectiveFn: (mu: number[]) => number` 这个写法——这是**函数类型签名**，表示"接收 number 数组，返回 number"。

**Python 对比**：

```python
def frank_wolfe(
    initial_mu: list[float],
    objective_fn: Callable[[list[float]], float],  # 函数类型
    gradient_fn: Callable[[list[float]], list[float]],
    lmo_fn: Callable[[list[float]], list[float]],
    options: FrankWolfeOptions | None = None
) -> FrankWolfeResult:
    opts = options or {}
    max_iterations = opts.get("max_iterations", 150)
    tolerance = opts.get("tolerance", 1e-6)
    # ...
```

TypeScript 的解构赋值比 Python 的 `dict.get()` 更优雅。

### 箭头函数

TypeScript 的箭头函数 `=>` 等价于 Python 的 `lambda`，但功能更强大（可以多行）：

```typescript
// 单行
const double = (x: number): number => x * 2;

// 多行
const processOrder = (order: TradeOrder): OrderStatus => {
  // 可以写多行逻辑
  return { orderId: order.id, status: 'pending', /* ... */ };
};

// 作为回调
orders.map((order) => order.price);     // 类似 Python: [o.price for o in orders]
orders.filter((o) => o.price > 0.5);    // 类似 Python: [o for o in orders if o.price > 0.5]
```

Python 的 lambda 只能写一个表达式，TypeScript 的箭头函数没有这个限制。

---

## 8. 泛型

泛型是 TypeScript 的杀手级特性。Python 3.12 之后有类似支持，但 TypeScript 的更成熟。

### 基本泛型函数

```typescript
// src/utils/singleton.ts — 泛型工厂函数
export function createSingleton<T>(factory: () => T) {
  let instance: T | null = null;
  return {
    get: (): T => {
      instance ??= factory();
      return instance;
    },
    reset: (): void => {
      instance = null;
    },
  };
}
```

> 📁 源文件：`src/utils/singleton.ts`

`<T>` 是类型参数，调用时 TypeScript 会自动推断 `T` 的具体类型：

```typescript
// 使用时不需要手动指定 T
const loggerSingleton = createSingleton(() => new Logger());
// TypeScript 自动推断：loggerSingleton.get() 返回 Logger 类型
```

**Python 对比**：

```python
from typing import TypeVar, Generic, Callable, Optional

T = TypeVar('T')

def create_singleton(factory: Callable[[], T]) -> ...:
    instance: Optional[T] = None
    # Python 没有很好的方式返回带类型的对象字面量
    # 需要定义一个类来包装
```

### 泛型类

```typescript
// src/di/container.ts:12-18
type Factory<T> = (container: Container) => T;

interface Registration<T> {
  factory: Factory<T>;
  instance?: T;
  singleton: boolean;
}
```

> 📁 源文件：`src/di/container.ts`

### 泛型方法

```typescript
// src/di/container.ts:32-36
registerSingleton<T>(token: string, factory: Factory<T>): this {
  this.registrations.set(token, { factory, singleton: true });
  return this;   // 返回 this 支持链式调用
}
```

`this` 作为返回类型是 TypeScript 特有的，表示"返回当前实例，支持链式调用"：

```typescript
container
  .registerSingleton('logger', (c) => new Logger())
  .registerSingleton('config', (c) => loadConfig());
```

**Python 对比**：

```python
from typing import Self  # Python 3.11+

class Container:
    def register_singleton(self, token: str, factory: Callable) -> Self:
        self._registrations[token] = factory
        return self
```

---

## 9. 类与继承

### 抽象类

```typescript
// src/strategies/base.ts:31-92
export abstract class BaseStrategy {
  protected config: StrategyConfig;   // protected: 子类可访问
  protected lastTradeTime = 0;
  protected name: string;

  constructor(name: string, config: Partial<StrategyConfig> = {}) {
    this.name = name;
    this.config = {
      enabled: true,
      maxPositionSize: 1000,
      minConfidence: 0.5,
      cooldownMs: 1000,
      ...config,   // 展开运算符：用传入的值覆盖默认值
    };
  }

  // 抽象方法：子类必须实现
  abstract analyze(data: StrategyMarketData[]): TradeSignal | null;

  // 具体方法：子类可直接使用
  protected canTrade(): boolean {
    if (this.config.enabled === false) return false;
    const now = Date.now();
    const cooldown = this.config.cooldownMs ?? 1000;
    if (now - this.lastTradeTime < cooldown) return false;
    return true;
  }

  getName(): string {
    return this.name;
  }

  // Partial<T> 让所有属性变成可选
  updateConfig(config: Partial<StrategyConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
```

> 📁 源文件：`src/strategies/base.ts`

**Python 对比**：

```python
from abc import ABC, abstractmethod

class BaseStrategy(ABC):
    def __init__(self, name: str, config: dict | None = None):
        self.name = name                         # Python 没有 private/protected
        self._config = {                         # 约定 _ 前缀表示 protected
            "enabled": True,
            "max_position_size": 1000,
            **(config or {})
        }

    @abstractmethod
    def analyze(self, data: list[StrategyMarketData]) -> TradeSignal | None:
        ...

    def can_trade(self) -> bool:
        if not self._config.get("enabled"):
            return False
        # ...
```

### 访问修饰符

| TypeScript | Python | 含义 |
|-----------|--------|------|
| `public`（默认） | 无前缀 | 所有人可访问 |
| `protected` | `_` 前缀（约定） | 只有自身和子类可访问 |
| `private` | `__` 前缀（约定） | 只有自身可访问 |

TypeScript 的访问修饰符是**编译时强制的**，Python 的只是约定。

### 接口实现（implements）

```typescript
// src/api/trading-client.ts
export interface TradingClient {
  placeOrder(order: OrderRequest): Promise<OrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
}

// 类通过 implements 声明实现接口
export class SignedClobTradingClient implements TradingClient {
  async placeOrder(order: OrderRequest): Promise<OrderResponse> { /* ... */ }
  async cancelOrder(orderId: string): Promise<void> { /* ... */ }
}
```

> 📁 源文件：`src/api/trading-client.ts`、`src/api/signed-clob-client.ts`

**Python 对比**：

```python
from typing import Protocol  # Python 3.8+

class TradingClient(Protocol):
    async def place_order(self, order: OrderRequest) -> OrderResponse: ...
    async def cancel_order(self, order_id: str) -> None: ...

# Python 用 Protocol（结构子类型），不需要显式 implements
class SignedClobTradingClient:
    async def place_order(self, order: OrderRequest) -> OrderResponse:
        ...
```

---

## 10. 枚举与常量

TypeScript 社区倾向于使用**联合类型**代替传统枚举：

### 联合类型做枚举（推荐）

```typescript
// src/utils/logger.ts:7
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// src/execution/canary-trade-persistence.ts
export type CanaryTradeRecordStatus =
  | 'dry-run'
  | 'submitted'
  | 'open'
  | 'filled'
  | 'cancelled'
  | 'failed'
  | 'unknown';
```

这种方式的优势：
- 编译后完全消失（零运行时开销）
- 直接用字符串值，JSON 序列化/反序列化无需转换
- TypeScript 会检查你是否漏掉了某个 case

### 常量对象做枚举映射

```typescript
// src/utils/logger.ts:22-27
private static readonly LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
```

> 📁 源文件：`src/utils/logger.ts`

**Python 对比**：

```python
from enum import Enum

class LogLevel(str, Enum):
    DEBUG = 'debug'
    INFO = 'info'
    WARN = 'warn'
    ERROR = 'error'

# 或者用 Literal（更接近 TS 的做法）
LogLevel = Literal['debug', 'info', 'warn', 'error']
```

---

## 11. 异步编程

TypeScript 的异步模型和 Python 的 asyncio 很像，但有一个关键区别：**Node.js 天生就是异步的**，不需要手动启动事件循环。

### async/await 基础

```typescript
// src/execution/execution-engine.ts:69-108
async executeOrder(order: TradeOrder): Promise<OrderStatus> {
  const startTime = performance.now();

  try {
    const status = await this.submitOrder(order);
    return status;
  } catch (error) {
    const errorStatus: OrderStatus = {
      orderId: order.id,
      status: 'error',
      filledSize: 0,
      remainingSize: order.size,
      avgPrice: 0,
      timestamp: Date.now(),
      error: getErrorMessage(error),
    };
    return errorStatus;
  }
}
```

> 📁 源文件：`src/execution/execution-engine.ts`

**Python 对比**：

```python
async def execute_order(self, order: TradeOrder) -> OrderStatus:
    start_time = time.perf_counter()

    try:
        status = await self.submit_order(order)
        return status
    except Exception as error:
        return OrderStatus(
            order_id=order.id,
            status='error',
            error=str(error),
            # ...
        )
```

几乎一模一样！核心区别：
- TypeScript 返回 `Promise<T>`，Python 返回 `Coroutine`
- TypeScript 不需要 `asyncio.run()`
- TypeScript 的 `catch` 捕获的 `error` 类型是 `unknown`（后面详细讲）

### Promise.all — 并行执行

```typescript
// src/execution/execution-engine.ts:115-130
async executeParallel(orders: TradeOrder[]): Promise<ExecutionResult> {
  // 所有订单并行执行
  const results = await Promise.all(
    orders.map((order) =>
      this.executeOrder(order).catch(
        (error: unknown): OrderStatus => ({
          orderId: order.id,
          status: 'error',
          filledSize: 0,
          remainingSize: order.size,
          avgPrice: 0,
          timestamp: Date.now(),
          error: getErrorMessage(error),
        })
      )
    )
  );
  // ...
}
```

**Python 对比**：

```python
# Python 使用 asyncio.gather
results = await asyncio.gather(
    *[self.execute_order(order) for order in orders],
    return_exceptions=True
)
```

### 跨进程原子占位（高级模式）

```typescript
// src/execution/order-idempotency-store.ts
claim(key: string, order: OrderRequest): IdempotentOrderRecord {
  // `wx` 对应 O_EXCL：文件已存在时失败，多个 Node 进程也只能有一个成功。
  const file = fs.openSync(filePath, 'wx', 0o600);
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  fs.fsyncSync(file);
  fs.closeSync(file);
  return record;
}
```

> 📁 源文件：`src/execution/order-idempotency-store.ts`

Python 单进程内可以使用 `asyncio.Lock()`；跨进程仍需数据库唯一约束或 `O_EXCL` 等原子机制。

---

## 12. 模块系统

### 导入/导出

```typescript
// 命名导出（推荐）
// src/execution/types.ts
export interface TradeOrder { /* ... */ }
export interface OrderStatus { /* ... */ }

// 导入
import { TradeOrder, OrderStatus } from './types.js';  // 注意 .js 扩展名（ESM 要求）

// 默认导出（一个文件只能有一个）
export default class Logger { /* ... */ }
import Logger from './logger.js';

// 仅导入类型（编译后完全消失）
import type { AppConfig } from '../utils/config-schema.js';

// 重新导出
export type { TradeOrder, OrderStatus };
export { OrderBookManager, getOrderBookManager } from './order-book-manager.js';
```

> 📁 源文件：`src/execution/execution-engine.ts:13-27`，`src/market/order-book.ts:15-20`

**Python 对比**：

```python
# Python
from execution.types import TradeOrder, OrderStatus
from utils.config_schema import AppConfig

# Python 没有 "import type" 的区别（TYPE_CHECKING 除外）
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from utils.config_schema import AppConfig  # 类似 import type
```

**关键差异**：
- TypeScript ESM 中导入必须带 `.js` 扩展名（即使源文件是 `.ts`）
- `import type` 告诉编译器这个导入只用于类型，编译后删除
- Python 用 `from __init__.py` 管理包，TypeScript 用 `index.ts`

---

## 13. 错误处理

### unknown 类型与类型守卫

TypeScript 的 `catch` 块中，`error` 的类型是 `unknown`（不像 Python 可以指定异常类型）：

```typescript
// src/utils/errors.ts
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

> 📁 源文件：`src/utils/errors.ts`

为什么是 `unknown`？因为 JavaScript 中 `throw` 可以抛出任何值：

```typescript
throw "字符串也能抛出";
throw 42;
throw { code: 500, msg: "error" };
throw new Error("标准错误");
```

所以必须先检查类型才能安全使用：

```typescript
try {
  await someOperation();
} catch (error) {
  // error 的类型是 unknown，不能直接访问 .message
  if (error instanceof Error) {
    console.log(error.message);  // 现在 TypeScript 知道这是 Error
  }
  // 或者用工具函数
  const msg = getErrorMessage(error);
}
```

**Python 对比**：

```python
try:
    await some_operation()
except ValueError as e:      # Python 可以精确捕获特定异常
    print(e)
except Exception as e:       # 捕获所有异常
    print(str(e))
```

TypeScript 的 `catch` 不能按类型区分，只能在 catch 内部用 `instanceof` 检查。

### 类型守卫（Type Guards）

`instanceof` 检查后，TypeScript 会自动缩窄（narrow）变量的类型：

```typescript
// src/execution/canary-trade-persistence.ts
function isCanaryTradeRecord(value: unknown): value is CanaryTradeRecord {
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Partial<CanaryTradeRecord>;
  return typeof record.runId === 'string' && typeof record.status === 'string';
}
```

`value is CanaryTradeRecord` 是用户定义的类型谓词；返回 `true` 后，调用方会把 `value` 缩窄为对应类型。

> 📁 源文件：`src/execution/canary-trade-persistence.ts`

---

## 14. 工具类型

TypeScript 内置了许多实用的类型变换工具。

### Partial\<T\> — 所有属性变可选

```typescript
// src/strategies/base.ts:36
constructor(name: string, config: Partial<StrategyConfig> = {}) {
  this.config = {
    enabled: true,           // 默认值
    maxPositionSize: 1000,
    minConfidence: 0.5,
    cooldownMs: 1000,
    ...config,               // 传入的值覆盖默认值
  };
}
```

`Partial<StrategyConfig>` 把所有属性变成可选的：

```typescript
interface StrategyConfig {
  enabled?: boolean;          // 原本可能是 required
  maxPositionSize?: number;   // Partial 让它们全部变成 optional
  minConfidence?: number;
  cooldownMs?: number;
}
```

**Python 对比**：

```python
# Python 没有内置 Partial，通常用 **kwargs 或 TypedDict(total=False)
def __init__(self, name: str, **config: Any):
    self.config = {"enabled": True, "max_position_size": 1000, **config}
```

### Record\<K, V\> — 键值对映射

```typescript
// src/utils/logger.ts:22
private static readonly LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Record<string, unknown> 等价于 Python 的 dict[str, Any]
context: Record<string, unknown> = {};
```

`Record<LogLevel, number>` 确保所有 `LogLevel` 值都必须有对应的条目——少写一个会报错。

### 常用工具类型速查

| 工具类型 | 效果 | Python 近似 |
|---------|------|------------|
| `Partial<T>` | 所有属性变可选 | `TypedDict(total=False)` |
| `Required<T>` | 所有属性变必需 | `TypedDict(total=True)` |
| `Pick<T, 'a' \| 'b'>` | 只保留指定属性 | 手动创建子 TypedDict |
| `Omit<T, 'a'>` | 排除指定属性 | 无内置方案 |
| `Record<K, V>` | 键值对映射 | `dict[K, V]` |
| `Readonly<T>` | 所有属性变只读 | `@dataclass(frozen=True)` |
| `ReturnType<F>` | 获取函数返回类型 | 无内置方案 |
| `Awaited<T>` | 解开 Promise 获取内部类型 | 无 |

---

## 15. 运行时验证（Zod）

TypeScript 的类型在编译后消失。如果你需要在运行时验证外部数据（API 响应、环境变量、用户输入），需要用 Zod 这样的库。

Zod 之于 TypeScript，就像 Pydantic 之于 Python。

### 定义 Schema

```typescript
// src/utils/config-schema.ts:8-34
import { z } from 'zod';

export const AlgorithmConfigSchema = z.object({
  ALPHA: z.number().min(0).max(1).default(0.9),
  INITIAL_EPSILON: z.number().positive().default(0.1),
  CONVERGENCE_THRESHOLD: z.number().positive().default(1e-6),
  MAX_ITERATIONS: z.number().int().positive().default(150),
  MIN_PROFIT_THRESHOLD: z.number().nonnegative().default(0.05),
  BARRIER_PARAMETER: z.number().positive().default(1.0),
});

// z.infer 从 Schema 自动推导出 TypeScript 类型——一处定义，两处使用
export type AlgorithmConfig = z.infer<typeof AlgorithmConfigSchema>;
// 等价于手写：
// type AlgorithmConfig = {
//   ALPHA: number;
//   INITIAL_EPSILON: number;
//   CONVERGENCE_THRESHOLD: number;
//   MAX_ITERATIONS: number;
//   MIN_PROFIT_THRESHOLD: number;
//   BARRIER_PARAMETER: number;
// }
```

> 📁 源文件：`src/utils/config-schema.ts`

### 验证数据

```typescript
// 解析环境变量——不合法的值会直接抛出详细错误
const config = AlgorithmConfigSchema.parse({
  ALPHA: parseFloat(process.env.ALPHA ?? '0.9'),
  MAX_ITERATIONS: parseInt(process.env.MAX_ITERATIONS ?? '150', 10),
  // ...
});
```

### 枚举验证

```typescript
// src/utils/config-schema.ts:113-115
export const LogConfigSchema = z.object({
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SILENT: z.boolean().default(false),
});
```

**Python 对比（Pydantic）**：

```python
from pydantic import BaseModel, Field
from typing import Literal

class AlgorithmConfig(BaseModel):
    alpha: float = Field(default=0.9, ge=0, le=1)
    initial_epsilon: float = Field(default=0.1, gt=0)
    convergence_threshold: float = Field(default=1e-6, gt=0)
    max_iterations: int = Field(default=150, gt=0)

class LogConfig(BaseModel):
    log_level: Literal['debug', 'info', 'warn', 'error'] = 'info'
    silent: bool = False
```

几乎一一对应。核心区别是 Zod 用 `z.infer<typeof Schema>` 推导类型，Pydantic 的类型就是类本身。

---

## 16. 实用技巧

### 严格模式（`"strict": true`）

本项目开启了最严格的 TypeScript 配置：

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,                    // 启用所有严格检查
    "noUncheckedIndexedAccess": true,  // 数组索引返回 T | undefined
    "exactOptionalPropertyTypes": true, // 可选属性不能赋值 undefined
    "noImplicitReturns": true,         // 每个分支都必须有返回值
    "noUnusedLocals": true,            // 不允许未使用的变量
    "noUnusedParameters": true         // 不允许未使用的参数
  }
}
```

> 📁 源文件：`tsconfig.json`

**强烈建议**新项目直接开 `strict: true`。就像 Python 项目一开始就配好 mypy strict 模式。

### `import type` — 纯类型导入

```typescript
// src/di/container.ts:9
import type { AppConfig } from '../utils/config-schema.js';
```

这告诉编译器和打包器：这个导入只用于类型检查，编译后完全删除。好处：
- 避免循环依赖问题
- 减少编译后的代码体积

Python 等价：

```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from utils.config_schema import AppConfig
```

### 展开运算符 `...` — 对象/数组合并

```typescript
// 合并对象（浅拷贝 + 覆盖）
const config = { ...defaults, ...userConfig };

// 等价 Python
config = {**defaults, **user_config}

// 合并数组
const all = [...arr1, ...arr2];

// 等价 Python
all = [*arr1, *arr2]
```

### `as const` — 字面量类型推断

```typescript
// 没有 as const
const levels = ['debug', 'info', 'warn', 'error'];
// 类型: string[]

// 有 as const
const levels = ['debug', 'info', 'warn', 'error'] as const;
// 类型: readonly ['debug', 'info', 'warn', 'error']
// 每个元素都是精确的字面量类型
```

### 单例模式的优雅实现

```typescript
// src/utils/singleton.ts — 泛型单例工厂
export function createSingleton<T>(factory: () => T) {
  let instance: T | null = null;
  return {
    get: (): T => {
      instance ??= factory();  // 空值合并赋值
      return instance;
    },
    reset: (): void => {
      instance = null;          // 用于测试清理
    },
  };
}

// 使用
const { get: getLogger, reset: resetLogger } = createSingleton(() => new Logger());
```

> 📁 源文件：`src/utils/singleton.ts`

比 Python 的单例模式（`__new__` 或模块级变量）更简洁，且自带 `reset()` 方法方便测试。

---

## 附录：快速对照表

| 概念 | Python | TypeScript |
|------|--------|------------|
| 变量声明 | `x = 1` | `const x = 1` / `let x = 1` |
| 类型注解 | `x: int = 1` | `const x: number = 1` |
| 字典/对象 | `{"key": value}` | `{ key: value }` |
| 列表/数组 | `[1, 2, 3]` | `[1, 2, 3]` |
| f-string/模板 | `f"Hello {name}"` | `` `Hello ${name}` `` (反引号) |
| None/null | `None` | `null` / `undefined` |
| 推导式 | `[x*2 for x in lst]` | `lst.map(x => x*2)` |
| 过滤 | `[x for x in lst if x>0]` | `lst.filter(x => x>0)` |
| 字典推导 | `{k: v for k,v in items}` | `Object.fromEntries(items)` |
| 解包/解构 | `a, b = [1, 2]` | `const [a, b] = [1, 2]` |
| 字典解包 | `{**d1, **d2}` | `{...d1, ...d2}` |
| 类型联合 | `str \| int` | `string \| number` |
| 可选类型 | `Optional[str]` | `string \| undefined` 或 `?` |
| 抽象类 | `ABC` + `@abstractmethod` | `abstract class` + `abstract method()` |
| 协议/接口 | `Protocol` | `interface` |
| 异步函数 | `async def f():` | `async function f(): Promise<T>` |
| 并行执行 | `asyncio.gather()` | `Promise.all()` |
| 包管理 | `pip` / `uv` | `npm` / `pnpm` |
| 类型检查 | `mypy` | `tsc --noEmit` |
| 测试 | `pytest` | `jest` / `vitest` |
| 格式化 | `ruff` / `black` | `prettier` |
| Lint | `ruff` | `eslint` |

---

> 如果你想深入某个主题，可以直接查看源文件中的完整代码。本项目是一个很好的 TypeScript 实战学习资源。
