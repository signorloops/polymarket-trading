# Polymarket 套利交易系统完善计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复所有 ESLint 错误、完成 API 集成、拆分大文件、配置环境、合并分支，使项目达到生产就绪状态

**Architecture:** 采用分阶段修复策略：先修复 ESLint 错误（按文件分组），然后完成 API 集成，接着拆分超大文件，最后完成 Git 工作流

**Tech Stack:** TypeScript, ESLint, Jest, Polymarket API, Git worktree

---

## 阶段 1: 修复 ESLint 错误（可自动修复的 103 个）

### Task 1: 运行自动修复命令

**Files:**
- Modify: 所有 `.ts` 文件

**Step 1: 运行 ESLint 自动修复**

```bash
cd ./.worktrees/feature/polymarket-trading
npm run lint -- --fix
```

**Step 2: 验证修复结果**

```bash
npm run lint 2>&1 | grep -c "error"
```

Expected: 错误数从 401 减少到约 298 个

**Step 3: 运行测试确保没有破坏功能**

```bash
npm test
```

Expected: 286 个测试全部通过

**Step 4: 提交**

```bash
git add -A
git commit -m "style: auto-fix ESLint errors with --fix"
```

---

## 阶段 2: 修复核心算法文件的 ESLint 错误

### Task 2: 修复 `src/core/bregman-projection.ts`

**Files:**
- Modify: `src/core/bregman-projection.ts`
- Test: `tests/core/bregman-projection.test.ts`

**错误清单:**
- 5 个未使用导入
- 1 个 `Array<T>` 类型
- 多个 `any[]` 类型问题
- 多个非空断言 `!`

**Step 1: 修复未使用导入**

删除第 16-19, 21 行的未使用导入：
```typescript
// 删除这些行:
// vectorScale,
// vectorAdd,
// vectorLog,
// vectorExp,
// zeros,
```

**Step 2: 修复 Array 类型**

第 51 行: `Array<Constraint>` → `Constraint[]`
第 155 行: `Array<number>` → `number[]`

**Step 3: 修复 any[] 类型问题**

第 72 行: 添加类型断言
第 78, 91, 97, 99, 115 行: 添加类型保护
第 106, 122 行: 明确类型

**Step 4: 修复非空断言**

第 83, 84, 138, 205 行: 使用可选链或类型守卫

**Step 5: 运行测试**

```bash
npm test -- tests/core/bregman-projection.test.ts
```

Expected: PASS

**Step 6: 提交**

```bash
git add src/core/bregman-projection.ts
git commit -m "style: fix ESLint errors in bregman-projection.ts"
```

---

### Task 3: 修复 `src/core/frank-wolfe.ts`

**Files:**
- Modify: `src/core/frank-wolfe.ts`
- Test: `tests/core/frank-wolfe.test.ts`

**错误清单:**
- 4 个未使用导入
- 1 个 `Array<T>` 类型
- 多个非空断言 `!`
- 3 个模板字符串 number 类型问题

**Step 1: 删除未使用导入（第 19-22 行）**

**Step 2: 修复 Array 类型（第 63 行）**

**Step 3: 修复模板字符串问题（第 181, 297, 301 行）**

使用 `String(value)` 或 `${value as number}`

**Step 4: 修复非空断言**

第 73, 76, 77, 105, 114, 115, 118, 119, 126, 410 行

**Step 5: 运行测试并提交**

```bash
npm test -- tests/core/frank-wolfe.test.ts
git add src/core/frank-wolfe.ts
git commit -m "style: fix ESLint errors in frank-wolfe.ts"
```

---

### Task 4: 修复 `src/core/init-fw.ts`

**Files:**
- Modify: `src/core/init-fw.ts`

**错误清单:**
- 2 个未使用导入
- 多个非空断言

**Step 1: 删除未使用导入（第 13, 15 行）**

**Step 2: 修复非空断言（第 126, 129, 130, 158, 161, 162, 246, 262, 265, 266 行）**

**Step 3: 运行测试并提交**

```bash
npm test -- tests/core/init-fw.test.ts
git add src/core/init-fw.ts
git commit -m "style: fix ESLint errors in init-fw.ts"
```

---

### Task 5: 修复 `src/core/marginal-polytope.ts`

**Files:**
- Modify: `src/core/marginal-polytope.ts`

**错误清单:**
- 多个模板字符串 number 类型问题
- 多个 `any[]` 类型问题
- 多个非空断言
- 2 个可推断类型
- 2 个 `Array<T>` 类型

**Step 1: 修复模板字符串问题（第 60, 72, 161 行）**

**Step 2: 修复 any[] 类型（第 129, 142, 155 行）**

**Step 3: 修复非空断言（第 144, 157, 173, 207, 214 行）**

**Step 4: 修复可推断类型（第 167, 243 行）**

**Step 5: 修复 Array 类型（第 243, 244 行）**

**Step 6: 运行测试并提交**

```bash
npm test -- tests/core/marginal-polytope.test.ts
git add src/core/marginal-polytope.ts
git commit -m "style: fix ESLint errors in marginal-polytope.ts"
```

---

## 阶段 3: 修复 API 和工具文件

### Task 6: 修复 `src/api/polymarket-client.ts`

**Files:**
- Modify: `src/api/polymarket-client.ts`

**错误清单:**
- 多个模板字符串类型问题
- 多个 `any` 返回类型
- 2 个 `Array<T>` 类型
- 1 个 Promise reject 错误类型

**Step 1: 修复模板字符串问题（第 96, 108, 121, 135 行）**

使用 `String(value)` 包装

**Step 2: 修复 any 返回类型（第 156, 164, 176, 184, 199, 208, 216, 230, 245 行）**

添加明确的返回类型

**Step 3: 修复 Array 类型（第 171, 172, 243 行）**

**Step 4: 修复 Promise reject（第 101 行）**

使用 `new Error()`

**Step 5: 运行测试并提交**

```bash
npm test -- tests/api/polymarket-client.test.ts
git add src/api/polymarket-client.ts
git commit -m "style: fix ESLint errors in polymarket-client.ts"
```

---

### Task 7: 修复 `src/api/polymarket-ws.ts`

**Files:**
- Modify: `src/api/polymarket-ws.ts`

**错误清单:**
- 2 个 `Array<T>` 类型
- 2 个 `any` 赋值问题
- 1 个模板字符串问题

**Step 1: 修复 Array 类型（第 21, 22 行）**

**Step 2: 修复 any 赋值（第 128 行）**

**Step 3: 修复模板字符串（第 213 行）**

**Step 4: 运行测试并提交**

```bash
npm test -- tests/api/polymarket-ws.test.ts
git add src/api/polymarket-ws.ts
git commit -m "style: fix ESLint errors in polymarket-ws.ts"
```

---

### Task 8: 修复 `src/di/container.ts`

**Files:**
- Modify: `src/di/container.ts`

**错误清单:**
- 1 个未使用类型
- 2 个不必要的类型参数
- 1 个未使用变量

**Step 1: 删除未使用类型 Constructor（第 12 行）**

**Step 2: 简化类型参数（第 51, 60 行）**

**Step 3: 删除未使用变量（第 143 行）**

**Step 4: 运行测试并提交**

```bash
npm test -- tests/di/container.test.ts
git add src/di/container.ts
git commit -m "style: fix ESLint errors in container.ts"
```

---

### Task 9: 修复执行引擎文件

**Files:**
- Modify: `src/execution/execution-engine.ts`
- Modify: `src/execution/order-manager.ts`
- Modify: `src/execution/position-sizing.ts`

**Step 1: 修复 execution-engine.ts**
- 修复模板字符串问题（第 90, 99, 158, 162 行）
- 修复 catch 变量类型（第 106 行）
- 修复 nullish 合并（第 176 行）
- 删除未使用参数下划线（第 281 行）

**Step 2: 修复 order-manager.ts**
- 修复可推断类型（第 68 行）
- 修复模板字符串（第 80 行）

**Step 3: 修复 position-sizing.ts**
- 修复 any[] 赋值（第 185 行）
- 修复非空断言（第 190, 191, 193, 194, 209, 210, 211 行）
- 修复模板字符串（第 300 行）

**Step 4: 运行测试并提交**

```bash
npm test -- tests/execution/
git add src/execution/
git commit -m "style: fix ESLint errors in execution module"
```

---

### Task 10: 修复剩余文件

**Files:**
- Modify: `src/utils/metrics.ts`
- Modify: 其他剩余文件

**Step 1: 修复 metrics.ts（17 个错误）**

**Step 2: 修复其他零散错误**

**Step 3: 运行完整测试**

```bash
npm test
npm run lint
git add -A
git commit -m "style: fix remaining ESLint errors"
```

---

## 阶段 4: 完成 API 集成

### Task 11: 研究 Polymarket API

**Files:**
- Read: `src/api/polymarket-client.ts`
- Read: `.env.example`

**Step 1: 了解现有 API 客户端实现**

**Step 2: 确定需要实现的 API 端点**
- 下单 API
- 撤单 API
- 订单查询 API

**Step 3: 提交研究笔记**

```bash
git add docs/
git commit -m "docs: add Polymarket API research notes"
```

---

### Task 12: 实现真实订单提交

**Files:**
- Modify: `src/execution/execution-engine.ts:260-279`

**Step 1: 修改 submitOrder 方法**

```typescript
private async submitOrder(order: TradeOrder): Promise<OrderStatus> {
  const client = this.container.resolve<PolymarketClient>('polymarketClient');

  try {
    const response = await client.placeOrder({
      marketId: order.marketId,
      side: order.side,
      size: order.size,
      price: order.price,
    });

    return {
      orderId: response.orderId,
      status: response.status === 'filled' ? 'filled' : 'open',
      filledSize: response.filledSize || 0,
      remainingSize: order.size - (response.filledSize || 0),
      avgPrice: response.avgPrice || order.price,
      timestamp: Date.now(),
    };
  } catch (error) {
    this.logger.error(`Failed to submit order: ${error}`);
    throw error;
  }
}
```

**Step 2: 运行测试**

```bash
npm test -- tests/execution/execution-engine.test.ts
```

**Step 3: 提交**

```bash
git add src/execution/execution-engine.ts
git commit -m "feat: implement real order submission via Polymarket API"
```

---

### Task 13: 实现真实订单取消

**Files:**
- Modify: `src/execution/execution-engine.ts:281-284`

**Step 1: 修改 submitCancel 方法**

```typescript
private async submitCancel(orderId: string): Promise<void> {
  const client = this.container.resolve<PolymarketClient>('polymarketClient');

  try {
    await client.cancelOrder(orderId);
    this.logger.info(`Order ${orderId} cancelled successfully`);
  } catch (error) {
    this.logger.error(`Failed to cancel order ${orderId}: ${error}`);
    throw error;
  }
}
```

**Step 2: 运行测试并提交**

```bash
npm test -- tests/execution/execution-engine.test.ts
git add src/execution/execution-engine.ts
git commit -m "feat: implement real order cancellation via Polymarket API"
```

---

## 阶段 5: 拆分大文件

### Task 14: 拆分 `src/index.ts`（358 行）

**Files:**
- Create: `src/bootstrap.ts`（启动逻辑）
- Create: `src/shutdown.ts`（关闭逻辑）
- Modify: `src/index.ts`（简化为主入口）

**Step 1: 创建 bootstrap.ts**

将初始化逻辑从 index.ts 移动到 bootstrap.ts

**Step 2: 创建 shutdown.ts**

将关闭逻辑从 index.ts 移动到 shutdown.ts

**Step 3: 简化 index.ts**

```typescript
import { bootstrap } from './bootstrap';
import { setupShutdownHandlers } from './shutdown';

async function main(): Promise<void> {
  const app = await bootstrap();
  setupShutdownHandlers(app);
}

main().catch(console.error);
```

**Step 4: 运行测试并提交**

```bash
npm test
git add src/index.ts src/bootstrap.ts src/shutdown.ts
git commit -m "refactor: split index.ts into bootstrap.ts and shutdown.ts"
```

---

### Task 15: 拆分 `src/core/frank-wolfe.ts`（364 行）

**Files:**
- Create: `src/core/fw-helpers.ts`（辅助函数）
- Create: `src/core/fw-types.ts`（类型定义）
- Modify: `src/core/frank-wolfe.ts`

**Step 1: 提取类型定义到 fw-types.ts**

**Step 2: 提取辅助函数到 fw-helpers.ts**

**Step 3: 简化 frank-wolfe.ts**

**Step 4: 运行测试并提交**

```bash
npm test -- tests/core/frank-wolfe.test.ts
git add src/core/frank-wolfe.ts src/core/fw-helpers.ts src/core/fw-types.ts
git commit -m "refactor: split frank-wolfe.ts into smaller modules"
```

---

### Task 16: 拆分 `src/execution/execution-engine.ts`（325 行）

**Files:**
- Create: `src/execution/order-executor.ts`（订单执行逻辑）
- Modify: `src/execution/execution-engine.ts`

**Step 1: 提取订单执行逻辑到 order-executor.ts**

**Step 2: 简化 execution-engine.ts**

**Step 3: 运行测试并提交**

```bash
npm test -- tests/execution/
git add src/execution/
git commit -m "refactor: split execution-engine.ts, extract order-executor.ts"
```

---

## 阶段 6: 环境配置

### Task 17: 创建 .env 文件

**Files:**
- Create: `.env`
- Read: `.env.example`

**Step 1: 基于 .env.example 创建 .env**

```bash
cp .env.example .env
```

**Step 2: 编辑 .env 文件**

设置合理的默认值（不包含真实密钥）

**Step 3: 验证 .env 在 .gitignore 中**

```bash
grep "^\.env" .gitignore
```

Expected: `.env` 在 .gitignore 中

**Step 4: 提交 .env.example 更新**

```bash
git add .env.example
git commit -m "chore: update .env.example with all required variables"
```

**注意:** 不要提交 .env 文件本身

---

## 阶段 7: 创建 TODO.md

### Task 18: 创建 TODO.md

**Files:**
- Create: `TODO.md`

**Step 1: 创建 TODO.md 文件**

```markdown
# Polymarket 套利交易系统 - 待办事项

## 进行中
- [ ] 等待用户配置真实 API 密钥到 .env 文件

## 待办
- [ ] 实盘交易测试（小额）
- [ ] 监控面板配置（Grafana 仪表板）
- [ ] 性能优化（根据实际运行数据）
- [ ] 添加更多交易策略

## 已完成
- [x] 核心算法实现（Frank-Wolfe、Bregman 投影）
- [x] 风险管理模块
- [x] 订单管理系统
- [x] API 集成
- [x] 测试覆盖（286 个测试）
- [x] ESLint 规范整改
- [x] 代码拆分
```

**Step 2: 提交**

```bash
git add TODO.md
git commit -m "docs: add TODO.md for tracking remaining work"
```

---

## 阶段 8: Git 工作流完成

### Task 19: 合并 feature 分支到 main

**Files:**
- 所有文件

**Step 1: 切换到 main 分支**

```bash
git checkout main
```

**Step 2: 合并 feature 分支**

```bash
git merge feature/polymarket-trading --no-ff -m "feat: complete polymarket trading system implementation"
```

**Step 3: 验证合并**

```bash
git log --oneline -5
npm test
npm run lint
```

Expected: 所有测试通过，ESLint 错误为 0

**Step 4: 推送（可选）**

```bash
git push origin main
```

---

### Task 20: 清理 worktree

**Step 1: 列出 worktree**

```bash
git worktree list
```

**Step 2: 移除 worktree（可选，保留开发环境）**

```bash
git worktree remove ./.worktrees/feature/polymarket-trading
```

**注意:** 如果还需要在 feature 分支上工作，可以保留 worktree

---

## 验证清单

完成所有任务后，运行以下验证：

```bash
# 1. 测试通过率
npm test
# Expected: 286 passing

# 2. ESLint 检查
npm run lint
# Expected: 0 errors

# 3. 类型检查
npx tsc --noEmit
# Expected: 0 errors

# 4. 构建检查
npm run build
# Expected: 成功构建

# 5. Git 状态
git status
# Expected: working tree clean

# 6. 分支状态
git log --oneline --graph -10
# Expected: feature 分支已合并到 main
```

---

## 总结

完成此计划后，项目将达到：
- ✅ 0 个 ESLint 错误
- ✅ 100% 测试通过（286/286）
- ✅ API 集成完成（实盘就绪）
- ✅ 代码文件大小符合规范（<400 行）
- ✅ 环境配置完整
- ✅ Git 工作流整洁（main 分支包含所有代码）
