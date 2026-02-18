# 贡献指南

感谢您对 Polymarket 套利交易系统的兴趣！我们欢迎所有形式的贡献。

## 开发环境设置

1. Fork 并克隆仓库
```bash
git clone https://github.com/YOUR_USERNAME/polymarket-trading.git
cd polymarket-trading
```

2. 安装依赖
```bash
npm install
```

3. 复制环境变量配置
```bash
cp .env.example .env
```

4. 运行测试确保一切正常
```bash
npm test
```

## 开发流程

### 1. 创建分支
```bash
git checkout -b feature/your-feature-name
```

### 2. 进行更改
- 遵循现有的代码风格
- 所有代码必须通过 ESLint 检查
- 所有代码必须通过 Prettier 格式化
- 为新功能添加测试
- 保持测试覆盖率在 80% 以上

### 3. 运行检查
```bash
# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 格式化
npm run format

# 运行测试
npm run test:coverage
```

### 4. 提交更改
我们使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
feat: 新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式调整（不影响代码功能）
refactor: 代码重构
perf: 性能优化
test: 添加或修改测试
chore: 构建过程或辅助工具的变动
```

示例：
```bash
git commit -m "feat: add new arbitrage strategy for conditional markets"
```

### 5. 推送到您的 Fork
```bash
git push origin feature/your-feature-name
```

### 6. 创建 Pull Request
- 填写 PR 模板中的所有信息
- 确保所有 CI 检查通过
- 等待代码审查

## 代码规范

### TypeScript
- 启用严格模式
- 所有函数必须有返回类型
- 避免使用 `any` 类型
- 使用接口定义对象类型

### 测试
- 所有新功能必须有测试覆盖
- 测试覆盖率必须保持在 80% 以上
- 使用描述性的测试名称
- 遵循 AAA (Arrange-Act-Assert) 模式

### 文档
- 更新相关的 README 文档
- 为公共 API 添加 JSDoc 注释
- 更新架构文档（如相关）

## 安全

- 绝不提交私钥或 API 密钥
- 敏感配置必须通过环境变量
- 提交前运行 `npm audit` 检查安全漏洞

## 性能

- 运行基准测试确保性能不会退化
- 优化算法前请先进行性能分析
- 参考 `benchmarks/` 目录中的示例

## 报告问题

如果您发现了 bug 或有功能建议，请：

1. 先搜索现有的 Issues 避免重复
2. 使用对应的 Issue 模板
3. 提供尽可能详细的信息
4. 如果是 bug，请提供复现步骤

## 代码审查

所有提交都需要通过代码审查：

- 至少一个维护者的批准
- 所有 CI 检查必须通过
- 没有未解决的讨论

## 获取帮助

如果您需要帮助：

1. 查看文档：`docs/` 目录
2. 查看示例：`examples/` 目录
3. 在 Issue 中提问，标签为 `question`

## 许可证

通过贡献代码，您同意您的贡献将在 MIT 许可证下发布。

感谢您的贡献！🎉
