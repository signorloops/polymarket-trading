# 全项目代码审查与修复 TODO（2026-02-19）

## 审查范围
- 代码静态检查：`eslint`、`tsc --noEmit`
- 构建验证：`tsc`
- 全量测试：`jest --runInBand`
- 重点回归：WebSocket 重连、测试生命周期清理、集成测试异步泄漏

## TODO 清单
- [x] 修复 `DataPipeline` 在 `close` 后未清空 `ws` 引用导致重连被阻断的问题  
  位置：`src/market/data-pipeline.ts`
- [x] 修复 `PolymarketWebSocketClient` 同类 `close` 生命周期问题  
  位置：`src/api/polymarket-ws.ts`
- [x] 修复集成测试中 `start()` 后未 `stop()` 的资源泄漏问题  
  位置：`tests/integration/trading-system.test.ts`
- [x] 更新 WebSocket 重连相关测试，使其匹配“`close` 后连接引用置空”的正确语义  
  位置：`tests/api/polymarket-ws.test.ts`
- [x] 回归验证 `data-pipeline` 与 `polymarket-ws` 单测及 trading-system 集成测试
- [x] 完成全项目验证（typecheck/lint/build/test）

## 验证结果
- `npm run typecheck` 通过
- `npm run lint` 通过
- `npm run build` 通过
- `npm test -- --runInBand` 通过（39 suites, 1062 tests）

## 后续可选优化（非阻塞）
- [ ] 在集成测试中对 WebSocket 连接统一做 mock，减少 `ENOTFOUND ws.polymarket.com` 日志噪音并提升测试可重复性
- [x] 为交易追踪器补充持久化实现（当前已支持本地 JSON 持久化与恢复）  
  位置：`src/blockchain/transaction-tracker.ts`
