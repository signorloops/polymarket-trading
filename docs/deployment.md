# 部署指南

## 环境要求

- Node.js 20.19+
- npm 9+ 或 pnpm 8+
- Git
- Docker (可选)
- Docker Compose (可选)

## 本地开发环境

### 1. 克隆仓库

```bash
git clone <repository-url>
cd polymarket-trading
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，配置以下参数：

```env
# === 网络配置 ===
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY
WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_SECRET=your_polymarket_api_secret
POLYMARKET_PASSPHRASE=your_polymarket_api_passphrase
POLYMARKET_CHAIN_ID=137
POLYMARKET_SIGNATURE_TYPE=0
POLYMARKET_FUNDER_ADDRESS=

# === 手动 canary 交易 (默认 dry-run) ===
CANARY_TOKEN_ID=
CANARY_SIDE=buy
CANARY_SIZE=
CANARY_PRICE=
CANARY_MAX_NOTIONAL_USD=5
CANARY_DRY_RUN=true
CANARY_TRADING_ENABLED=false
CANARY_CONFIRMATION=
CANARY_STATE_PATH=.state/canary-trades.json
CANARY_KILL_SWITCH_PATH=.state/canary-kill-switch.json

# === 钱包配置 (生产环境必需) ===
PRIVATE_KEY=0x...your_private_key...
WALLET_ADDRESS=0x...your_wallet_address...

# === 守护进程运行时配置 ===
TRADING_SYSTEM_CONFIG_PATH=/app/config/trading-system.json
HTTP_HOST=0.0.0.0
HTTP_PORT=3000
HTTP_RISK_STATUS_TOKEN=replace-with-at-least-16-random-characters
HTTP_METRICS_TOKEN=replace-with-at-least-16-random-characters
ORDER_IDEMPOTENCY_DIR=.state/order-idempotency
RISK_STATE_FILE=.state/risk-state.json
RECONCILE_ON_STARTUP=false

# === 算法参数 ===
ALPHA=0.9
INITIAL_EPSILON=0.1
MAX_ITERATIONS=150
MIN_PROFIT_THRESHOLD=0.05
CONVERGENCE_THRESHOLD=0.000001

# === 交易参数 ===
MAX_POSITION_PCT=0.5
SLIPPAGE_TOLERANCE=0.02
MAX_CONCURRENT_TRADES=5

# === 风险管理 ===
MAX_DAILY_LOSS=1000
MAX_EXPOSURE=10000
EMERGENCY_STOP_THRESHOLD=500
MAX_POSITION_SIZE=1000

# === 日志配置 ===
LOG_LEVEL=info
SILENT=false
```

### 4. 运行测试

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率报告
npm run test:coverage

# 运行性能基准测试
npx tsx benchmarks/frank-wolfe.bench.ts
```

### 额外：生成并校验守护进程配置

```bash
npm run runtime-config:generate -- ./config/trading-system.json
npm run runtime-config:validate -- ./config/trading-system.json
npm run smoke:daemon
npm run smoke:docker
npm run reconcile:balances
```

### 5. 启动开发服务器

```bash
npm run dev
```

## Docker 部署

### 方法一：使用 Dockerfile

#### 1. 构建镜像

```bash
docker build -t polymarket-trading:latest .
```

#### 2. 运行容器

```bash
docker run -d \
  --name polymarket-trading \
  --env-file .env \
  -v $(pwd)/config:/app/config:ro \
  --mount source=polymarket-state,target=/app/.state \
  -p 3000:3000 \
  --restart unless-stopped \
  polymarket-trading:latest
```

#### 3. 查看日志

```bash
docker logs -f polymarket-trading
```

### 方法二：使用 Docker Compose (推荐)

#### 1. 启动完整栈

```bash
docker-compose up -d
```

这将启动：

- 交易服务 (端口 3000)
- Prometheus 监控 (端口 9090)
- Grafana 仪表盘 (端口 3001)

#### 2. 查看服务状态

```bash
docker-compose ps
```

#### 3. 查看日志

```bash
# 所有服务
docker-compose logs -f

# 仅交易服务
docker-compose logs -f trading-bot

# 仅监控服务
docker-compose logs -f prometheus grafana
```

#### 4. 停止服务

```bash
docker-compose down
```

#### 5. 重启服务

```bash
docker-compose restart
```

## 生产环境部署

### 服务器要求

| 组件 | 最低配置  | 推荐配置  |
| ---- | --------- | --------- |
| CPU  | 2 核      | 4 核+     |
| 内存 | 4 GB      | 8 GB+     |
| 存储 | 20 GB SSD | 50 GB SSD |
| 网络 | 10 Mbps   | 100 Mbps+ |

### 部署步骤

#### 1. 准备服务器

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose
```

#### 2. 部署应用

```bash
# 克隆代码
git clone <repository-url>
cd polymarket-trading

# 配置环境变量
cp .env.example .env
nano .env  # 编辑配置

# 准备运行时配置
mkdir -p config .state
cp config/trading-system.example.json config/trading-system.json

# 使用 Docker Compose 启动
docker-compose --profile monitoring up -d
```

#### 3. 配置 Nginx 反向代理 (可选)

```nginx
server {
    listen 80;
    server_name trading.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /metrics {
        proxy_pass http://localhost:3000/metrics;
    }
}
```

#### 4. 配置 SSL (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d trading.yourdomain.com
```

#### 5. 设置系统服务

创建 `/etc/systemd/system/polymarket-trading.service`:

```ini
[Unit]
Description=Polymarket Trading System
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/polymarket-trading
ExecStart=/usr/local/bin/docker-compose up -d
ExecStop=/usr/local/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl enable polymarket-trading
sudo systemctl start polymarket-trading
sudo systemctl status polymarket-trading
```

## 监控配置

### Prometheus

默认配置已包含在 `monitoring/prometheus.yml` 中。

访问: `http://localhost:9090`

### Grafana

#### 1. 访问 Grafana

URL: `http://localhost:3001`
默认账号: `admin/admin`

#### 2. 配置数据源

1. 登录 Grafana
2. 前往 Configuration > Data Sources
3. 添加 Prometheus 数据源
4. URL: `http://prometheus:9090`
5. 保存并测试

#### 3. 导入仪表盘

1. 前往 Create > Import
2. 上传 `monitoring/grafana/dashboards/trading-dashboard.json`
3. 选择 Prometheus 数据源
4. 导入

### 告警配置

在 `monitoring/prometheus/alerts.yml` 中配置告警规则：

```yaml
groups:
  - name: trading_alerts
    rules:
      - alert: HighDailyLoss
        expr: daily_loss_usd > 500
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'High daily loss detected'

      - alert: EmergencyStopTriggered
        expr: risk_manager_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: 'Emergency stop triggered'
```

## 备份与恢复

### 备份配置

```bash
#!/bin/bash
# backup.sh

BACKUP_DIR="/backups/polymarket-trading"
DATE=$(date +%Y%m%d_%H%M%S)

# 备份环境变量
cp .env "$BACKUP_DIR/env_$DATE"

# 备份日志
tar -czf "$BACKUP_DIR/logs_$DATE.tar.gz" logs/

# 清理旧备份 (保留 30 天)
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +30 -delete
```

### 恢复

```bash
# 恢复环境变量
cp $BACKUP_DIR/env_20240217_120000 .env

# 重启服务
docker-compose restart
```

## 故障排查

### 常见问题

#### 1. 容器无法启动

```bash
# 检查日志
docker-compose logs trading

# 检查端口冲突
sudo lsof -i :3000
sudo lsof -i :9090
```

#### 2. 内存不足

```bash
# 查看内存使用
docker stats

# 增加交换空间
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

#### 3. WebSocket 连接断开

```bash
# 检查网络连接
curl -I https://ws-subscriptions-clob.polymarket.com

# 检查日志中的重连信息
docker-compose logs -f trading-bot | grep -i "reconnect"
```

#### 4. 交易未执行

检查风险限制：

```bash
# 查看风险状态（未配置 token 时该接口返回 404）
curl -H "Authorization: Bearer $HTTP_RISK_STATUS_TOKEN" \
  http://localhost:3000/api/risk/status
```

### 调试模式

```bash
# 启用调试日志
LOG_LEVEL=debug docker-compose up

# 进入容器调试
docker-compose exec trading sh
```

## 安全最佳实践

### 1. 密钥管理

- 绝不将私钥提交到 Git
- 使用 Docker Secrets 或环境变量注入
- 定期轮换 API 密钥

### 2. 网络安全

- 使用防火墙限制端口访问
- 启用 SSL/TLS
- 使用 VPN 访问管理接口
- 非 loopback 监听时必须配置 `HTTP_METRICS_TOKEN`；Docker Compose 使用 `.secrets/metrics-token`

```bash
mkdir -p .secrets
openssl rand -hex 32 > .secrets/metrics-token
chmod 600 .secrets/metrics-token
curl -H "Authorization: Bearer $(cat .secrets/metrics-token)" \
  http://localhost:3000/metrics
```

### 3. 容器安全

```dockerfile
# 使用非 root 用户
USER node

# 只读文件系统
read_only: true

# 限制资源
mem_limit: 2g
cpus: 1.5
```

## 升级指南

### 升级到新版本

```bash
# 1. 备份当前配置
cp .env .env.backup

# 2. 拉取最新代码
git pull origin main

# 3. 更新依赖
npm install

# 4. 重建镜像
docker-compose build --no-cache

# 5. 重启服务
docker-compose up -d

# 6. 验证升级
curl http://localhost:3000/health
```

### 回滚

```bash
# 恢复到上一个版本
git checkout HEAD~1
docker-compose up -d --build
```

## 环境变量参考

| 变量                         | 说明                                            | 默认值                           | 必填                                   |
| ---------------------------- | ----------------------------------------------- | -------------------------------- | -------------------------------------- |
| `RPC_URL`                    | Solana RPC 节点                                 | -                                | 是                                     |
| `WS_URL`                     | Polymarket WebSocket                            | -                                | 是                                     |
| `POLYMARKET_API_KEY`         | API 密钥                                        | -                                | canary 真单/签名客户端需要             |
| `POLYMARKET_SECRET`          | CLOB API secret                                 | -                                | canary 真单必填                        |
| `POLYMARKET_PASSPHRASE`      | CLOB API passphrase                             | -                                | canary 真单必填                        |
| `POLYMARKET_CHAIN_ID`        | CLOB 签名链 ID                                  | 137                              | 否                                     |
| `POLYMARKET_SIGNATURE_TYPE`  | CLOB 签名类型：0=EOA, 1=代理钱包, 2=Gnosis Safe | 0                                | canary 真单必填                        |
| `POLYMARKET_FUNDER_ADDRESS`  | Polymarket profile/proxy funder 地址            | -                                | 代理钱包必填                           |
| `TRADING_SYSTEM_CONFIG_PATH` | 守护进程配置文件路径                            | -                                | production daemon 必填                 |
| `TRADING_SYSTEM_CONFIG_JSON` | 守护进程 JSON 配置                              | -                                | 与 `TRADING_SYSTEM_CONFIG_PATH` 二选一 |
| `HTTP_HOST`                  | HTTP 监听地址（本地默认仅 loopback）             | 127.0.0.1                        | 否                                     |
| `HTTP_PORT`                  | health/metrics HTTP 端口                        | 3000                             | 否                                     |
| `HTTP_RISK_STATUS_TOKEN`     | 风险状态接口 Bearer token（至少 16 字符）        | -（接口关闭）                    | 否                                     |
| `HTTP_METRICS_TOKEN`         | metrics Bearer token（非 loopback 监听时必需）   | -                                | 公网/容器监听必填                      |
| `HTTP_METRICS_TOKEN_FILE`    | 从挂载文件读取 metrics token                    | -                                | 与内联 token 二选一                    |
| `ORDER_IDEMPOTENCY_DIR`      | 跨进程订单唯一键日志目录                        | `.state/order-idempotency`       | 真单必需                               |
| `RISK_STATE_FILE`            | 仓位、PnL 与 circuit breaker 持久化文件          | -                                | 自动实盘必需                           |
| `RECONCILE_ON_STARTUP`       | 启动前全量读取配置 token 余额并对账              | false                            | 自动实盘必需                           |
| `CANARY_TOKEN_ID`            | 单笔 canary 的 CLOB token id                    | -                                | canary 必填                            |
| `CANARY_MAX_NOTIONAL_USD`    | 单笔 canary notional 上限，代码硬上限 5 USD     | 5                                | 否                                     |
| `CANARY_DRY_RUN`             | canary dry-run 开关                             | true                             | 否                                     |
| `CANARY_TRADING_ENABLED`     | canary 真实提交开关                             | false                            | canary 真实提交必填                    |
| `CANARY_CONFIRMATION`        | canary 真实提交确认短语                         | -                                | canary 真实提交必填                    |
| `CANARY_STATE_PATH`          | canary 状态文件路径                             | `.state/canary-trades.json`      | 否                                     |
| `CANARY_KILL_SWITCH_PATH`    | canary kill switch 状态文件路径                 | `.state/canary-kill-switch.json` | 否                                     |

## Canary Runbook

紧急停单：

```bash
npm run canary:kill-switch -- activate "operator reason"
```

查看 kill switch 状态：

```bash
npm run canary:kill-switch -- status
```

取消所有 canary 未终态订单：

```bash
npm run canary:cancel-all
```

解除 kill switch：

```bash
npm run canary:kill-switch -- deactivate
```

建议顺序：

1. 先执行 `activate`
2. 再执行 `cancel-all`
3. 检查 `CANARY_STATE_PATH` 里是否仍有 `manualInterventionRequired=true`
4. 只在问题确认解除后再 `deactivate`

自动实盘的完整硬门禁和操作顺序见 [live-trading-readiness.md](./live-trading-readiness.md)。其中多腿原子成交仍是明确的硬阻塞项，补偿平仓不等于原子性。

---

## 支持和反馈

- GitHub Issues: [提交问题](https://github.com/your-repo/issues)
- 文档: [完整文档](./README.md)
- 邮箱: support@example.com
