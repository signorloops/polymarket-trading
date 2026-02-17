# 部署指南

## 环境要求

- Node.js 18+
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
WS_URL=wss://ws.polymarket.com
POLYMARKET_API_KEY=your_polymarket_api_key

# === 钱包配置 (生产环境必需) ===
PRIVATE_KEY=0x...your_private_key...
WALLET_ADDRESS=0x...your_wallet_address...

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
  -p 3000:3000 \
  -p 9090:9090 \
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
docker-compose logs -f trading

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

| 组件 | 最低配置 | 推荐配置 |
|------|---------|---------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 存储 | 20 GB SSD | 50 GB SSD |
| 网络 | 10 Mbps | 100 Mbps+ |

### 部署步骤

#### 1. 准备服务器

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
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

# 使用 Docker Compose 启动
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
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
        proxy_pass http://localhost:9090;
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
          summary: "High daily loss detected"

      - alert: EmergencyStopTriggered
        expr: risk_manager_status == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Emergency stop triggered"
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
curl -I https://ws.polymarket.com

# 检查日志中的重连信息
docker-compose logs -f trading | grep -i "reconnect"
```

#### 4. 交易未执行

检查风险限制：
```bash
# 查看风险状态
curl http://localhost:3000/api/risk/status
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

| 变量 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `RPC_URL` | Solana RPC 节点 | - | 是 |
| `WS_URL` | Polymarket WebSocket | - | 是 |
| `POLYMARKET_API_KEY` | API 密钥 | - | 是 |
| `PRIVATE_KEY` | 钱包私钥 | - | 生产必填 |
| `WALLET_ADDRESS` | 钱包地址 | - | 生产必填 |
| `MAX_ITERATIONS` | 最大迭代次数 | 150 | 否 |
| `MIN_PROFIT_THRESHOLD` | 最小利润阈值 | 0.05 | 否 |
| `MAX_DAILY_LOSS` | 每日最大损失 | 1000 | 否 |
| `LOG_LEVEL` | 日志级别 | info | 否 |

---

## 支持和反馈

- GitHub Issues: [提交问题](https://github.com/your-repo/issues)
- 文档: [完整文档](./README.md)
- 邮箱: support@example.com
