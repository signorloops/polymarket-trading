# Polymarket 套利交易系统 - 待办事项

## 配置与部署

- [ ] 安全配置 CLOB Canary 与只读对账
  - 通过文件型 secret 配置 CLOB 凭证和用于订单签名的 `PRIVATE_KEY`
  - 配置 `WALLET_ADDRESS`/funder，并用 `POLYGON_RPC_URL` 只读查询 Polygon 主网余额
  - 不在日志、命令行参数或版本库中保存任何密钥
- [ ] 完成真实资金小额 Canary
  - 使用明确的单市场、单腿、限价和极小额度执行一次主网 Canary
  - 验证订单提交、认证用户流、查询、取消和终态持久化流程
  - 完成 CLOB API、Polymarket UI 与 Polygon 链上余额三方对账
  - 在 CLOB 不支持多腿原子成交期间，继续禁止自动跨市场实盘
- [ ] 监控面板配置（Grafana 仪表板）
  - 配置 Prometheus 数据源
  - 创建交易性能仪表板
  - 添加告警规则

## 功能扩展（P2）

- [ ] 分布式限流（Task 19）
  - Redis-backed 分布式限流
  - 不同 API 端点分级（交易 vs 市场数据）
  - 接近限流时的熔断器
- [ ] 添加更多交易策略
  - 跨市场统计套利
  - 波动率交易策略
  - 事件驱动策略

## 代码质量（P3）

- [ ] WebSocket 消息验证增强（Task 21）
  - Zod schemas 运行时消息验证
  - 价格合理性检查（二元市场 0 < price < 1）
  - 市场 ID 格式验证
- [ ] 混沌工程测试
  - 随机故障、延迟注入
  - 恢复场景测试（崩溃 mid-arbitrage）

## 技术债务

- [ ] 完善错误码文档（统一错误码体系）
- [ ] 添加架构决策记录 (ADR)
- [ ] Kubernetes 部署配置（K8s manifests 和 Helm chart）

## 注意事项

- 实盘交易前务必在 .env 中配置真实 API 密钥
- 首次实盘建议使用小额资金测试
- 监控日志和指标，确保系统稳定运行
