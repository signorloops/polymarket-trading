# AI Agent 交接文档 — Polymarket 套利系统全量代码审查

> **用途**：本文档是一次全量代码审查的完整结论，供后续 AI agent（或人类工程师）直接接手修复工作，无需重复审计。
> **生成时间**：2026-07-18 ｜ **审查基线 commit**：工作区（HEAD 附近，`6bfdedb` 之后）
> **基线状态**：`npm run typecheck` ✅ 通过；`npm test` ✅ 64 套件 / 1162 用例全部通过。

## 0. TL;DR

- 系统当前为 **paper-trading**，实盘被 readiness gate 禁用（`docs/live-trading-readiness.md`），**当前无直接资金风险**；但多处缺陷会在门控放开后立即变成资金风险。
- 发现 **3 个严重 + 8 个高 + 约 30 个中/低** 问题。最要害的三类：
  1. **数学正确性**：`bregmanProjection` 完全忽略价格向量（CORE-1）；LP 无界被报为 optimal（OPT-1）；B&B 分支策略不完备（OPT-2）；仓位计算 Kelly 卖出腿胜率口径错误 + 美元/份额单位混用（EXEC-2/EXEC-3）。
  2. **资金安全逻辑**：常规风控拒绝会误触全局熔断（EXEC-1）；断线重连后无快照门控，陈旧订单簿可被当成新鲜（MKT-1）。
  3. **测试假象**：1162 个测试全绿，但大量测试只断言"形状/不抛异常"，**几乎没有"对照已知最优解"的数值锚定测试**——上述严重数学 bug 全部与全绿测试并存。
- 已验证**正确**的部分也很多（skip-list、订单簿、FW 主循环、canary 防御、HTTP 认证、CI），见 §8，**不要重复审计**。
- **修复进度（2026-07-19）**：P0 全部 + P1 数学项已落地（见 §3 台账 ✅）；验证：`npm run typecheck` ✅、`npm test` 65 套件 / **1176** 用例全绿、`npm run lint` ✅。剩余见 P2/P3（INFRA-1、CORE-4..7、EXEC-5..7、API-12 完整 staleness 门槛、测试补强等）。

## 1. 项目速览

TypeScript ESM（Node ≥ 20），Polymarket 预测市场套利检测/交易系统：用边际多面体（marginal polytope）+ Frank-Wolfe + Bregman 投影检测价格不一致（KL 散度作为"incoherence"诊断量，**不是美元利润**），LP/MILP 由 `javascript-lp-solver` 支撑。

```
src/core/         边际多面体、Bregman 投影、Frank-Wolfe、LMO、线搜索
src/market/       订单簿（SkipList）、套利检测器、数据管道、payoff 模型、依赖图/约束构造（死代码）
src/optimization/ LP/IP 求解器封装 + 后备 branch-and-bound
src/execution/    执行引擎、风控、仓位、订单状态机、幂等存储（文件/Postgres）、canary 实盘入口
src/api/          Polymarket REST/WS 客户端、签名 CLOB 适配器
src/runtime/      HTTP server、优雅停机、入口、配置 CLI
src/utils|security|alerts/  配置、日志、脱敏、指标、告警
```

关键语义约定：

- 不等式约束统一为 `coefficients · x ≥ rhs`（core/market 一致；转 LP 时取负变 `≤`）。
- `MIN_PROFIT_THRESHOLD` 是**无量纲 KL 诊断阈值**，不能与美元 PnL 比较（文档 §7/§11.4 已强调，部分代码注释仍是旧语义，见 CORE-9）。
- 手续费模型：`rate · (p(1-p))^exponent`，三处实现一致（order-book.ts:266、payoff-model.ts:104、arbitrage-detector.ts）。

## 2. 环境与验证命令

```bash
npm run typecheck          # tsc --noEmit
npm test                   # 全量 jest（约 10s）
NODE_OPTIONS='--experimental-vm-modules' npx jest tests/core --silent   # 定向跑
npm run lint && npm run build
```

- 禁止读取/修改 `.env`；禁止 git 变更操作（commit/push/reset 等需用户显式批准）。
- 做数值验证时：编译到临时目录（`npx tsc -p tsconfig.json --outDir /tmp/pm-dist`）后在 /tmp 写脚本实验，**不要改仓库文件**。
- import 必须带 `.js` 后缀（ESM）；注释/提交信息遵循仓库现有英文惯例。

## 3. 发现总览

| ID | 严重度 | 模块 | 一句话 | 状态 |
|---|---|---|---|---|
| CORE-1 | 🔴 严重 | core | `bregmanProjection` 迭代从不使用 θ，算的是最大熵点而非 I-投影 | ✅ 已修复（2026-07-19） |
| OPT-1 | 🔴 严重 | optimization | 无界 LP/MILP 被误报为 `optimal` | ✅ 已修复（2026-07-19） |
| OPT-2 | 🔴 严重 | optimization | B&B 用等式定点分支（非界约束），搜索不完备，返回错误"最优" | ✅ 已修复（2026-07-19） |
| CORE-2 | 🟠 高 | core | LMO 快路径不验证 product-of-simplex 结构，重叠/负系数等式下返回不可行顶点 | ✅ 已修复（2026-07-19） |
| CORE-3 | 🟠 高 | core | LMO 在 LP 失败时静默回退到全局单纯形顶点（对多组可行域结构性不可行） | ✅ 已修复（2026-07-19） |
| OPT-3 | 🟠 高 | optimization | B&B 整数不可行时返回 `optimal` + 分数解 + `objectiveValue: Infinity` | ✅ 已修复（2026-07-19） |
| OPT-4 | 🟠 高 | optimization | `integerIndices`/`binaryIndices` 并存时后者不被检查也不被分支 | ✅ 已修复（2026-07-19） |
| EXEC-1 | 🟠 高 | execution | 常规风控拒绝（限额）会误触全局熔断，锁死全部交易 | ✅ 已修复（2026-07-19） |
| EXEC-2 | 🟠 高 | execution | 多腿卖出侧 Kelly 胜率口径错误，卖出腿超配约 12.8 倍 | ✅ 已修复（2026-07-19） |
| EXEC-3 | 🟠 高 | execution | position-sizing 美元与份额单位混用，流动性约束/EV 系统性失真 | ✅ 已修复（2026-07-19） |
| INFRA-1 | 🟠 高 | utils | 配置加密功能端到端断裂：能加密、运行时无解密消费（死功能） | |
| MKT-1 | 🟡 中 | market | 重连/首连后无快照-增量门控，陈旧订单簿可被 delta 刷新为"新鲜" | ✅ 已修复（2026-07-19） |
| MKT-2 | 🟡 中 | market | constraint-builder 对事件全部 markets 求和，双市场事件建模下不可行/空洞 | |
| CORE-4 | 🟡 中 | core | `barrierFrankWolfe` 返回的 objective/gap 含障碍项，违反结果语义与下界性质 | |
| CORE-5 | 🟡 中 | core | `MarginalPolytope.getBarycenter` 多事件返回不可行点 | |
| CORE-6 | 🟡 中 | core | `MarginalPolytope.project` 对非正组和输入返回不可行点 | |
| CORE-7 | 🟡 中 | core | `dualFunctionValue` 是伪对偶，不等式违反度方向错误 | |
| EXEC-4 | 🟡 中 | execution | 四处 O_EXCL 锁文件无陈旧锁回收，崩溃后永久死锁（同模式复制 4 份） | ✅ 已修复（2026-07-19） |
| EXEC-5 | 🟡 中 | execution | `reconcile()` 把"未查询"误当"已平仓"，静默删除持仓 | |
| EXEC-6 | 🟡 中 | execution | `handleTimedOutOrder` 把确认轮询失败误记为撤单失败 | |
| EXEC-7 | 🟡 中 | execution | 成交成本基础用限价而非实际成交均价 | |
| API-1 | 🟡 中 | api | WS 重连次数耗尽后通道永久静默死亡，无通知 | ✅ 已修复（2026-07-19） |
| API-2 | 🟡 中 | api | 价格排他校验 (0,1) 丢弃市价单事件；启动对账缓存 rejected Promise 可锁死下单 | ✅ 已修复（2026-07-19） |
| INFRA-2 | 🟡 中 | index.ts | `STRUCTURED_LOGGING` 被二次 `initLogger` 静默抹掉 | |
| INFRA-3 | 🟡 中 | utils | 模块级 child logger 在 `initLogger` 前冻结默认配置 | |
| INFRA-4 | 🟡 中 | utils | redact 正则漏 `CONFIG_ENCRYPTION_KEY`、RPC URL 内嵌 key 等秘密载体 | |
| INFRA-5 | 🟡 中 | docker | `.dockerignore` 未排除 `.secrets/`（进入 builder 中间层） | |
| OPT-5 | 🟡 中 | optimization | 非有限 rhs / matrix-rhs 不成对被静默吞掉（保护性约束无声失效） | ✅ 已修复（2026-07-19） |
| OPT-6 | 🟡 中 | optimization | `maxIterations` 选项语义错误且实际无效；MILP 路径未传 timeout/tolerance | |
| OPT-7 | 🟡 中 | optimization | MILP 后端结果零校验；`relaxationGap` 负目标时恒报 0 | 部分：B&B gap 用 `|lpObj|`（2026-07-19） |
| 低（约 20 条） | ⚪ 低 | 各模块 | 见 §6 各模块小节 |

## 4. 严重发现详情

### CORE-1 🔴 `bregmanProjection` 从不使用 θ，返回最大熵点而非 I-投影

- **位置**：`src/core/bregman-projection.ts:143`（μ 初始化为均匀分布）、`166-199`（IPF 主循环不引用 θ）、`186/202`（θ 仅用于事后算 divergence）
- **问题**：函数声明求 `min_{μ∈M} D_KL(μ‖θ)`，但 IPF 乘法拟合的极限是 `argmin_{μ∈M} D(μ‖μ⁰)`（μ⁰=初始表）。以均匀分布初始化 ⇒ 实际返回 M 中的**最大熵分布**，与 θ 无关；`theta[i] = max(price, 1e-10)` 的钳制毫无意义。
- **已复核**（审查者亲验源码 + 子代理数值实验）：`theta=[0.9,0.1]`/`[0.6,0.4]`/`[0.99,0.01]`（约束 μ0+μ1=1）全部返回 `[0.5,0.5]`；θ 本在单纯形上时真 I-投影应为 θ 自身且 divergence=0，报告值却为 0.51/0.02/1.61。
- **影响**：`projection` 与 `divergence` 两个返回值在数学上都是错的。**缓解**：当前生产无调用方（仅 `src/index.ts:627` re-export 与测试），爆炸半径限于公共 API 消费者。
- **修复**：μ 用钳制后的 θ 初始化（`mu[i]=max(theta[i],ε)`）；或改名为最大熵可行点计算器并改文档。配套测试必须断言"输出随 θ 变化"（见 CORE-8）。

### OPT-1 🔴 无界 LP/MILP 被误报为 `optimal`

- **位置**：`src/optimization/lp-solver.ts:73-79`；同缺陷 `src/optimization/ip-solver-utils.ts:192-200`
- **问题**：库在无界时返回 `{feasible: true, bounded: false, result: ±Infinity}`。wrapper 只查 `raw.feasible === false`，无界落入正常分支 → 取当前基可行点重算目标、通过可行性检查、返回 `status:'optimal'`。`lp-solver.ts:78` 的 `'unbounded'` 分支是死代码。
- **已复核**（审查者亲验源码 + 子代理实证）：`solveLP({objective:[-1], lowerBounds:[0]})`（min −x 无上界）→ `{solution:[0], objectiveValue:0, optimal:true}`。
- **影响**：`solveLMO` 在负梯度 + 仅 `>=` 约束时会把垃圾点当作多胞体最优顶点交给 Frank-Wolfe。
- **修复**：`raw.bounded === false`（或 `!Number.isFinite(raw.result)`）时返回 `status:'unbounded', optimal:false`；MILP 路径同理。

### OPT-2 🔴 B&B 分支策略数学上不完备（等式定点而非界约束）

- **位置**：`src/optimization/ip-solver-utils.ts:277-303`（`leftFixed/rightFixed.set(branchIdx, floor/ceil)`）+ `createSubproblem:355-366`（追加 `x_i = value` 等式）
- **问题**：标准 B&B 分支应给子问题加**界** `x_i ≤ floor(v)` / `x_i ≥ ceil(v)`，这里把变量**固定为点值**。某变量分支一次后，floor 以下、ceil 以上的所有整数值在整棵树中永久不可达。
- **已复核**（审查者亲验源码 + 子代理暴力枚举反例）：`min 3x−3y−2z s.t. 2x+3y+2z≤7, 2x+2y≤6, x,y,z∈[0,4]∩Z`，真最优 **−7**（如 (2,1,2)），`branchAndBound` 返回 **−6** 且报 `optimal`。
- **影响**：纯 0-1 变量（floor=0/ceil=1 覆盖全域）碰巧完备，故 `solveBinaryIP` 主用例不暴露；一般整数变量会返回错误答案并谎报 optimal。该函数是导出 API 且是 `solveIP` 的后备路径。
- **修复**：`createSubproblem` 改为克隆后收紧 `lowerBounds[idx]=ceil(v)` / `upperBounds[idx]=floor(v)`；把上述反例做成回归测试。

## 5. 高严重度发现详情

### CORE-2 🟠 LMO 快路径不验证结构假设，返回不可行顶点

- **位置**：`src/core/lmo.ts:59-102`（快路径）、`44-56`（等式过滤器要求 `coefficients.some(c => c > 0)`）
- **问题**：无不等式约束即走"每组独立选最小 `g_i/a_i`"快路径，但**从不检查**各等式组 support 是否两两不相交；全负系数等式（如 `−x0−x1=−1`）被过滤器静默丢弃；混合符号等式只取正系数坐标。
- **实证**：重叠约束 `x0+x1=1, x1+x2=1`、梯度 `[0.5,−1,−2]` → 返回 `[0,1,1]`（约束违反 1.0）；负系数等式例返回 `[0,0,1,0]`，第一条约束被无视。
- **缓解**：生产路径（`arbitrage-detector.ts:199`）约束来自 `MarginalPolytope`，恒含不等式 → 走 LP 路径，不受影响。
- **修复**：快路径前验证"组间 support 不相交且系数全 ≥ 0"，不满足回退 LP；被过滤约束至少记 warning。

### CORE-3 🟠 LMO 在 LP 失败时静默回退到全局单纯形顶点

- **位置**：`src/core/lmo.ts:117-122`（`{strict:false}`）、`src/optimization/lp-solver-utils.ts:217-233`（`fallbackSimplexVertex` 返回单个 1 的 e_i）
- **问题**：任何 LP 失败（含输入畸形、瞬时数值问题）都静默降级为全局单纯形顶点——对 k 组 product-of-simplex 可行域必然不可行（组和为 `[1,0,…,0]`），且无 degraded 信号；`frank-wolfe.ts:154` 的 `Math.max(0, gap)` clamp 进一步掩盖异常。
- **实证**：可行区域 2 组等式 + 1 条合法不等式 + 1 条长度畸形等式 → 返回 `[1,0,0,0]`（组和 `[1,0]`）。
- **修复**：fallback 至少按等式组构造（快路径形状）；在结果/日志中暴露 degraded 标志供上游熔断。

### OPT-3 🟠 B&B 在"LP 可行但整数不可行"时谎报 optimal

- **位置**：`src/optimization/ip-solver-utils.ts:246-257`（`bestValue = Infinity` 初始化）、`306-319`
- **实证**：`x ∈ Z, x = 0.5` → 返回 `{solution:[0.5], objectiveValue:Infinity, optimal:true, status:'optimal', integerFeasible:false}`。队列耗尽但未找到整数可行解时 incumbent 仍是 LP 分数解。
- **修复**：循环结束 `bestValue` 仍为 `Infinity` 时返回 `status:'infeasible', optimal:false`。

### OPT-4 🟠 `integerIndices` 与 `binaryIndices` 并存时漏查后者

- **位置**：`src/optimization/ip-solver-utils.ts:66`、`322-323`（`problem.integerIndices ?? problem.binaryIndices ?? []`）
- **实证**：`{integerIndices:[0], binaryIndices:[1]}` 下解 `[0, 0.5]` 被判 `integerFeasible === true`——索引 1 从不被迭代，既不做可行性检查也不被分支。
- **修复**：取两数组**并集**迭代（内部按 binary 区分的逻辑保留）。

### EXEC-1 🟠 常规风控拒绝误触全局熔断

- **位置**：`src/execution/execution-engine.ts:130-142`（风控拒绝在 try 内 throw）与 `165-174`（catch 对任何错误且 `apiClient` 非空时无条件 `triggerCircuitBreaker`）
- **已复核**（审查者亲验源码 + 子代理实证）：设 `maxExposure: 1`，一次普通限额拒绝后 `isCircuitBreakerActive() === true`，熔断原因是与事实不符的 "did not return a confirmed exchange state"。
- **影响**：任何一次正常限额拒绝（敞口/日亏/抵押品）都会永久锁死全系统交易，需人工 `resetCircuitBreaker`；熔断原因文案误导排查。
- **修复**：仅 `placeOrder` 发出后抛出的错误（真歧义）才触发熔断；风控拒绝直接返回 error 状态（把 :123-142 移出触发熔断的 try，或 catch 中按错误类型分流）。

### EXEC-2 🟠 多腿卖出侧 Kelly 胜率口径错误，卖出腿超配约 12.8 倍

- **位置**：`src/execution/position-sizing.ts:87-95`（公式）与 `:203`（`calculateMultiLegPositionSize` 调用）
- **问题**：`calculatePositionSize` 对 `side='sell'` 用 `b = price/(1−price)`，仍以入参 `probability` 为胜率 p；而多腿调用方传的是**结果发生概率**并用 `prob > price ? 'buy' : 'sell'` 选边——卖出腿的胜率应为 `1 − prob`。
- **实证**：`P=0.75, price=0.8` → 代码给 `size=1000`（顶格）；正确 modified-Kelly（胜率 0.25, b=4）仅 `78.125`。
- **缓解**：该模块仅 `index.ts` 导出、未接入实盘路径，属潜伏缺陷。
- **修复**：sell 腿传 `1 − prob`；补数值锚定测试。

### EXEC-3 🟠 position-sizing 美元与份额单位混用

- **位置**：`src/execution/position-sizing.ts:121`（`size = adjustedFraction * capital` 是**美元**）、`:132-133`（与 `getMaxExecutableSize` 返回的**份额**比较）、`:148-151`（EV 公式按份额解释 size）、`:159`（`fraction = size/capital` 又按美元）
- **问题**：同一函数内 size 在美元/份额两种口径间交叉使用，失真幅度约 `1/price` 倍（price=0.1 时 10 倍）。同模块 `calculateSingleMarketArbitrageSize:288` 的 `capital / (yesPrice + noPrice)` 是正确的换算对照。
- **修复**：Kelly 算出美元后 `/price` 转份额，再施加流动性/风险约束，EV 按份额算；或全文统一美元口径并换算所有限额。

### INFRA-1 🟠 配置加密端到端断裂（死功能）

- **位置**：`src/utils/config.ts:14-22`、`src/utils/config-encryption.ts:92-182`
- **问题**：`encryptEnvFile`/`decryptEnvFile`/`encryptObjectFields`/`verifyEncryptionKey` 的全部引用仅在自身与测试中；`config.ts` 加载链 `dotenv.config() → parseConfigFromEnv()` **没有 `ENC:v1:` 解密步骤**。运维若按功能意图加密 `.env`，`PRIVATE_KEY=ENC:v1:...` 会被 zod 正则拒绝 → 启动崩溃（fail-closed，不泄漏，但功能是死代码）。`CONFIG_ENCRYPTION_KEY` 在 `.env.example` 与 docs 中完全未出现。
- **修复**：补齐链路（启动解密 + encrypt/decrypt CLI + 文档化密钥），或删除该模块。

## 6. 中/低严重度发现（分模块）

### 6.1 src/core

- **CORE-4（中）** `barrierFrankWolfe` 返回的 objective/gap 含障碍项（`frank-wolfe.ts:264-305`），违反 `FrankWolfeResult` 的 "KL divergence" 语义；`objective − gap ≤ f*` 只对障碍目标成立。实证：θ=[0.6,0.4] 100 轮后纯 KL=0.000165，报告 objective=0.0169、gap=0.0115，`objective−gap=0.0054 > 0 = f*`。修复：返回前用 `objectiveFn(mu, 0)` 与无障碍梯度重算；仅测试使用。
- **CORE-5（中）** `MarginalPolytope.getBarycenter`（`marginal-polytope.ts:229-232`）返回全局均匀 `1/n`，k 事件可行域要求每组和为 1，多事件时不可行。修复：按事件分组填 `1/groupSize`。
- **CORE-6（中）** `MarginalPolytope.project`（`marginal-polytope.ts:205-215`）对非正组和输入返回不可行点（`project([-0.5,0.2,0.2]) → [0,0.2,0.2]`，组和 0.4）；`arbitrage-detector.ts:192` 用它生成 FW 初始点，市场数据异常时 FW 从不可行点出发且 FW 无可行性校验。修复：组和 ≤ 0 回退组内均匀；FW 入口断言初始点可行。
- **CORE-7（中）** `dualFunctionValue`（`bregman-projection.ts:246-261`）是伪对偶：`divergence − Σ|c·μ − r|` 无推导支持，且对不等式不分类型取 `|·|`（对 `x_i ≥ 0` 满足时仍计"违反"），注释却称 "guaranteed profit"。修复：删除或改名 `divergenceMinusEqualityViolation`，不等式按 `max(0, rhs − c·μ)` 计。
- **CORE-8（中，测试缺口）** core 测试从未断言"输出依赖输入 θ"/"对照已知最优解"：bregman 全部断言仅"和为 1/非负/converged"；FW 收敛用例只断言 ±0.05 精度。116 个测试全绿与"数学正确"几乎无相关性。修复：为每个算法件加已知闭式最优解的对照测试。
- **CORE-9（中，文档不一致）** "guaranteed profit" 旧语义残留：`arbitrage-utils.ts:21`、`bregman-projection.ts:8-9/271` 与 `docs/core-algorithm-theory-guide.md` §7/§11.4 直接矛盾（该量是 nats 单位的 incoherence，不能当美元利润）。修复：注释/命名统一为 incoherence 语义（`isSignificantIncoherence` 是正确范本）。
- **CORE-10（低）** `lineSearchKL` docstring 名不副实（`line-search.ts:8-35`）：实为恒等 Hessian 单步二次近似，非真线搜索（真 γ=0.200 vs 近似 0.406）。src 内无调用方。改 docstring 或删除。
- **CORE-11（低）** 杂项：`frank-wolfe.ts:162` 收敛判据 `gap ≤ tol·(1−ALPHA)·max(1,|f|)` 使有效阈值严 10 倍（文档 §3.2 有记载但配置注释牵强）；docs §6 步骤 3"全局归一化"代码并不做；`marginal-polytope.ts:100-103` 注释声称 "price consistency" 约束实际只有等式+盒子；`init-fw.ts:186-190` `validatePoint` 硬编码 `sum=1` 拒绝多事件 warm start（总和=k）；`init-fw.ts:22` `randomSeed` 声明未用、`initFWBarrier` 用 `Math.random()` 不可复现；`arbitrage-detector.ts:74` `lastResults` 死字段。

### 6.2 src/optimization

- **OPT-5（中）** 非有限 rhs 与 matrix/rhs 不成对被静默吞掉：`lp-solver-utils.ts:76`（NaN rhs 直接 return）、`122/140`（两者同时存在才建约束）；实证 `inequalityRhs:[NaN]` → 约束消失仍报 optimal；只传 matrix 不传 rhs → 整组不等式静默消失。套利语境下等于保护性约束无声失效。修复：`validateProblem` 对 NaN/Infinity 与不成对输入抛错。
- **OPT-6（中）** `maxIterations` 语义错误且无效：`lp-solver-utils.ts:96-98` 把它映射为库 `timeout`（wall-clock 毫秒，且只有 branch-and-cut 读它）；MILP 路径 `solveWithMilpBackend(problem, _options)` 完全不用 options。修复：删除或正确映射毫秒并文档化；MILP 传 `mipGap→tolerance` 与 timeout。
- **OPT-7（中）** MILP 后端结果零校验：`ip-solver-utils.ts:202-221` 无 `checkFeasibility` 重代入（对比 `solveLP` 有），`optimal:true` 可与 `integerFeasible:false` 同时成立；`solveIP`（`ip-solver.ts:79-88`）直接信任；`relaxationGap` 只在 `lpObjectiveValue > 0` 时计算，负目标恒报 0。修复：复用重代入；gap 分母用 `|lpObj|`。
- **OPT-8（低）** `enumerateVertices`（`ip-solver.ts:159-174`）完全忽略约束参数，恒返回单位向量——误导性死代码（测试还把该行为固化了）。
- **OPT-9（低）** 杂项：`ip-solver.ts:58-59` LP 非 optimal 时 error 恒为 'LP relaxation infeasible'（误导）；`ip-solver.ts:66-77` `nodeLimit ≤ 1` 早退报 `relaxationGap:0` 且 `iterations` 填的是 nodeLimit；`lp-solver.ts:129` `solveLMO` 空梯度返回 `[1]` 与 n 维契约不一致；`verbose` 选项定义未读；`checkFeasibility` 绝对容差 1e-6 不适配大数值规模（宜 `max(1,|rhs|)` 相对容差）；`javascript-lp-solver.d.ts` 弱类型导致到处 `as unknown as`。
- **OPT-10（中，测试缺口）** LP 测试无 unbounded/infeasible 用例；IP 93 个用例几乎无"已知整数最优值"精确断言；无"整数最优≠LP 松弛最优"、无"LP 可行整数不可行"、无 `binaryIndices ⊄ integerIndices` 用例；多处"占位符实现"宽松断言注释已过时。建议直接把 OPT-2 反例固化。

### 6.3 src/market

- **MKT-1（中）** 重连/首连后无快照门控：`data-pipeline.ts:345-377`（price_change → delta）、`order-book.ts:121`（任何 update 都刷 `lastUpdate`）、`index.ts:346-348`（'disconnected' 仅记日志不清书）。断线期间旧书保留，重连后 delta 可能先于快照到达并把整本书 `lastUpdate` 刷成当前 → `isStale` 通过，但其余档位全是断线前陈旧值。首连时 delta 先于首个快照会在空书上长出孤立档位。**影响：门控放开后是资金风险**（幻影深度 → 虚假套利信号）。修复：按 marketId 维护 awaitingSnapshot 状态，首个快照前忽略 delta 或标记不可用；或 disconnected 时清书。
- **MKT-2（中）** `constraint-builder.ts:77-84/109-122/137-145`（ME/implies/conditional）对 `event.markets` **全体**置 ±1：双市场（YES+NO）事件下 ME 约束使多面体不可行、implies/conditional 恒真空洞；只有"每事件仅挂单一 YES 市场"建模下语义才正确。当前死代码（仅 re-export）。修复：约束作用于显式 outcome 子集，或校验并文档化前提。
- **MKT-3（低）** `detector.updatePrice` 对未注册市场抛错（`index.ts:309-313` → `marginal-polytope.ts:63`），被 `data-pipeline.ts:464-474` 吞掉，同事件后续 risk manager/latestPrices 更新被跳过；`config.markets` 与 `config.events[].markets` 包含关系无校验。
- **MKT-4（低）** pipeline 价格校验闭区间 [0,1]（`data-pipeline.ts:498-501`）与 OrderBook 开区间（`order-book.ts:407-419`）不一致：含 0/1 档的整条快照被静默丢弃。建议统一开区间 + 逐档过滤。
- **MKT-5（低）** 残缺 book 消息（缺 bids/asks）经 `toLevels → []` 仍 emit snapshot，`replace([],[])` 清空真实流动性（`data-pipeline.ts:310-333`、`order-book.ts:126-134`）。字段缺失 ≠ 显式为空。
- **MKT-6（低）** `findArbitrageCycles` 的 `expectedReturn = Σ|price_i − price_{i+1}|`（`dependency-graph.ts:289-308`）无金融含义；DFS visited 全局标记只能发现部分环。死代码。
- **MKT-7（低）** `scoreOpportunity`（`arbitrage-detector.ts:316-341`）：`urgencyFactor = timeRemaining/60000` 恒 ≤ ~0.083（分母应为 `maxOrderBookAgeMs`）；`liquidityFactor` 用两侧深度 min/1000 硬编码（应按方向取单侧）。
- **MKT-8（低）** 死代码/资源错配：`arbitrage-detector.ts:74` `lastResults` 只清不写；`dependency-graph.ts` + `constraint-builder.ts` 全模块无生产调用却有 1387 行测试。
- **MKT-9（测试缺口）** 无乱序/重连场景测试（MKT-1 无覆盖）；skip-list 无删除边界与随机差分测试；order-book 无 snapshot/delta 高频交替一致性测试；`detectSingleMarketArbitrage` 基于 last-trade 价（两腿异步易假信号）无注释/测试说明。子代理已在 /tmp 用 16 万随机操作差分验证 skip-list/order-book 正确，建议把该差分测试固化进仓库。

### 6.4 src/execution

- **EXEC-4（中）** 四处 O_EXCL 锁文件无陈旧锁回收：`order-idempotency-store.ts:193`、`risk-manager.ts:772`、`canary-trade-persistence.ts:76`、`canary-kill-switch.ts:74`（同模式复制 4 份）。持锁窗口内崩溃（kill -9）→ `.lock` 残留 → 之后每次调用 EEXIST 永不自愈：幂等 journal 卡 `claimed`、风控 persist 失败触发熔断、canary 中止。实证确认。修复：锁内写 pid 并检测持锁进程存活（或 proper-lockfile 语义）；至少 EEXIST 错误信息提示"疑似陈旧锁"。
- **EXEC-5（中）** `risk-manager.ts:608-613` `reconcile()` 对不在 balances 映射里的持仓一律删除，无法区分"查询后为零"与"根本未查询"（`balance-reconciliation.ts:65`、`index.ts:519-523` 只传 `config.markets`）。市场被移出配置时启动对账静默丢弃持仓。修复：只对"显式查询但缺席"的资产 removed。
- **EXEC-6（中）** `order-lifecycle.ts:131-199` cancel 与 poll 同处一个 try：`pollOrderUntilTerminal` 内 `getOrder` 瞬时网络错误会被记为 `cancelSucceeded:false`，状态失真，可能误导人工处置。修复：分两个 try，poll 失败应记 `cancelSucceeded:true, cancelConfirmed:false`。
- **EXEC-7（中）** 成交成本基础用限价而非实际成交均价：`execution-engine.ts:473/340/353`（`avgPrice: response.price`）根源 `signed-clob-client.ts:594`。价格改善不反映 → 买入成本高估、浮亏高估、应急止损偏方向误触发。修复：从 getOrder/成交明细算实际 VWAP；至少文档标注近似方向。
- **EXEC-8（中，测试缺口）** Kelly 只有 `>=0` 断言无数值锚定（EXEC-2/3 因此漏网）；无 `capital=0`/零流动性用例（此时 `fraction`/`riskAdjustedReturn` 为 NaN，已实证）；无"风控拒绝不触发熔断"回归测试；无陈旧 `.lock` 恢复测试；无乱序/重复终态回报测试；并发 claim 仅单进程/pg-mem 无双进程 fork 用例。
- **EXEC-9（低）** `riskAdjustedReturn`/`sharpeRatio` 失真：`position-sizing.ts:154-155/240` 方差漏乘 b²、分母可 0/0=NaN、`sharpeRatio = expectedProfit/maxLoss` 无标准差项名不符实。
- **EXEC-10（低）** 费用硬编码 exponent=1 峰值 0.25（`risk-manager.ts:99/199/393-397`），与 canary 路径的可变 exponent ∈ [0,10]（`canary-trade.ts:584-588`）脱节；exponent<1 时"保守"预留反欠费。
- **EXEC-11（低）** `clearOldOrders` 清 `partial` 状态与引擎可撤语义冲突（`order-manager.ts:73` vs `execution-engine.ts:538-542`），且 `riskReservations` 条目泄漏永驻内存虚占敞口。
- **EXEC-12（低）** 尘埃级超卖（<1e-6 容差内）仓位滞留原值：`risk-manager.ts:319-368` `newSize` 微小负值时既不删除也不更新。
- **EXEC-13（低，安全）** `onchain-balance-reader.ts:109-111` 放行明文 `http://` RPC（URL 常内嵌 API key）。

### 6.5 src/api + src/runtime + src/index.ts

- **API-1（中）** WS 重连耗尽后通道永久静默死亡：`polymarket-ws.ts:354-357`、`polymarket-user-ws.ts:350-353` 仅记一行 error，不向订阅者发终态事件、无 `onGiveUp`；`reconnectAttempts` 只在 open 时重置。连续故障 ~10 次后永久关闭，仅靠 `/ready` 503 由编排层兜底。修复：耗尽时广播 terminal/error 事件、提供 `resetReconnect()`、状态接口暴露 `reconnectExhausted`。
- **API-2（中）** 市价单 price=0 问题：`polymarket-user-ws.ts:510-514` 要求 `0<p<1` → 市价单更新被当 malformed 静默丢弃（canary `waitForOrderUpdate` 等到超时）；`signed-clob-client.ts:306` `getOrder` 对市价单抛错——若启动对账遇遗留市价单 `submitted` 记录，`startupReconciliation`（`:431-434` 缓存记忆化）成为**永久 rejected Promise**，之后所有 `placeOrder` 永远失败。修复：按 order type 分支校验；对账区分"解析失败"与"账簿歧义"。
- **API-3（中，测试缺口）** user-ws 重连/心跳/超时几乎无测试（全文仅 4 用例）：退避重连、心跳 stale→terminate、订阅拒绝、waitUntilReady 超时、disconnect 拒绝 readyWaiters 全未覆盖——恰是重连状态机最复杂的模块。
- **API-4（中，测试缺口）** market-ws 死连检测（30s 无 PONG → terminate）与 PONG 文本帧刷新、重连后订阅重放/快照自愈路径无测试。
- **API-5（低）** 两个 WS 客户端退避均无抖动（`polymarket-ws.ts:364-368`、`polymarket-user-ws.ts:356`），多实例雷鸣群。
- **API-6（低）** user-ws `lastOrderUpdates` Map 只增不删（`:95/339`）；`disconnect()` 不 reject `waitForOrderUpdate` 等待者（`:161-174` vs `:216-241`）。
- **API-7（低）** REST 客户端无重试/限流，429/5xx 直接抛错无 Retry-After（`polymarket-client.ts:96-106/147-160`）。
- **API-8（低，安全）** `docker-smoke.ts:122-131` 端口发布 0.0.0.0 且 metrics token 硬编码源码固定值。
- **API-9（低）** WS 未设 maxPayload（默认 100MiB）；解析失败把完整原始报文写日志（`polymarket-ws.ts:73-75/161-167/207`）。
- **API-10（低）** `polymarket-ws.disconnect()` 不等待 close 完成（`:84-93`），语义弱于 DataPipeline 同名方法。
- **API-11（低）** runtime-config 不校验 market id 为数字（`runtime-config.ts:39` vs `polymarket-client.ts:367-371`），非数字 id 通过校验 → 订阅永远无数据 + 每 30s 失败告警噪声。
- **API-12（低）** 断线期间数据缺口对消费者不可见：重连后无 resync/gap 事件；主循环对 book 无 staleness 门槛（`index.ts:356-393`，当前 paper-only）。

### 6.6 基建（utils / security / alerts / 部署 / CI）

- **INFRA-2（中）** `STRUCTURED_LOGGING` 被二次初始化抹掉：`index.ts:112` 三参 init 后，`index.ts:511`（`initialize()` 内）以两参再 init（第三参缺省 false）→ 生产永远拿不到 JSON 日志。
- **INFRA-3（中）** 模块级 child logger 在 `initLogger` 前冻结默认配置：`metric-types.ts:22`、`metric-registry.ts:15`、`crypto-utils.ts:8`、`config-encryption.ts:20` 在 import 时即 `getLogger().child(...)`，拷贝当时配置，之后不再更新。
- **INFRA-4（中，安全）** `redact.ts:11-12` 正则漏：`CONFIG_ENCRYPTION_KEY`、`POLYGON_RPC_URL` 等 URL 内嵌 key；且只处理对象键值，message 字符串内嵌秘密永不脱敏。`config-encryption.ts:99-107` 与 redact 的秘密清单不一致。
- **INFRA-5（中，安全）** `.dockerignore` 未排除 `.secrets/`（`.gitignore:23` 有），`Dockerfile:13` builder `COPY . .` 把 metrics token/grafana 密码带进中间层镜像（最终镜像干净）。
- **INFRA-6（低）** metrics 高基数标签（`metric-registry.ts:172/193-201` market_id/event_id）；10000 上限后新市场指标静默丢弃仅 warn 一次。
- **INFRA-7（低）** `performance-alert-manager.ts:216` 告警 id 含 `Date.now()` → dedup 永不命中（`alert-notification-service.ts:335`），抖动指标每次越阈都外发。
- **INFRA-8（低）** `api-security.ts:315-335` `AnomalyDetector` 单信号最高 30 分 < 阈值 50，任何单一异常永不触发（需确认是否刻意）。
- **INFRA-9（低，文档不一致）** `.env.example` 缺 `STRUCTURED_LOGGING`、`HASH_SALT`；`config-schema.ts:58` 注释仍是旧 "guaranteed-profit" 语义（与 `.env.example:112-113` 已更正的无量纲 KL 语义漂移）。
- **INFRA-10（低，安全）** `Dockerfile.dev` root 运行 + 挂载整个仓库（可读宿主机 `.env`/`.secrets`，仅 dev profile）。

## 7. 死代码 / 休眠代码清单（处理前先确认保留意图）

| 代码 | 状态 | 备注 |
|---|---|---|
| `bregmanProjection`（CORE-1） | 生产无调用，仅 re-export + 测试 | 数学错误，修复或改名 |
| `barrierFrankWolfe`（CORE-4） | 仅测试 | 返回语义需修正 |
| `lineSearchKL`（CORE-10） | src 内无调用 | docstring 错误 |
| `dualFunctionValue`（CORE-7） | 仅测试 | 伪对偶，删除或改名 |
| `enumerateVertices`（OPT-8） | 仅 re-export | 忽略约束的 stub |
| `dependency-graph.ts` + `constraint-builder.ts`（MKT-2/6/8） | 无生产调用，1387 行测试 | 含建模缺陷；修复或移除 |
| `position-sizing.ts`（EXEC-2/3/9） | 仅 re-export，未接实盘 | 含数学错误；启用前必须修 |
| `config-encryption.ts`（INFRA-1） | 运行时无消费 | 补链路或删除 |
| `lastResults`（MKT-8）、`randomSeed`（CORE-11）、`verbose`（OPT-9） | 死字段/死选项 | 直接删除 |

## 8. 已验证正确（不要重复审计）

以下部分经精读 + 数值/差分实验确认无误：

- **数学基础**：`klDivergence`/`generalizedKLDivergence` 公式与 `0·log0` 约定；标准/广义 KL 梯度；`projectOntoSimplex`（Duchi 2008）；FW gap 定义与缩放收敛判据；`lineSearchObjective` golden-section；`adaptiveStepSize = 2/(k+2)`；IPF 乘法更新式本身（错的是初始化不是更新式）；`Float64ArrayPool` 无串扰（函数局部 + acquire 清零）。
- **FW 主链路**：`frankWolfe` + LP 后端 LMO + 真实目标线搜索端到端收敛到解析已知最优（maxErr 5.6e-8，目标单调下降，组和恒为 1）。注：生产初始点 `project(prices)` 对广义 KL 恰是闭式最优，FW 首轮即收敛——FW 在当前约束族下近似"昂贵的验证器"。
- **market 数据结构**：skip-list 插入/删除/查找/首尾指针全部正确（8 种子 × 2 万步差分对照 naive 实现）；OrderBook 增量 depth 50 万次更新零漂移；`replace` 先校验再重置；`getMaxExecutableSize` VWAP 推导正确；手续费模型三处一致；payoff-model 覆盖套利 LP 与 `guaranteedProfit` 定义正确。
- **execution 安全网**：canary 纵深防御（dry-run 默认、确认短语、$5 硬顶、kill switch fail-closed、前置检查、歧义落 unknown 强制人工对账）；幂等 journal claim 原子性（O_EXCL+fsync / PG PK+CAS）与"unknown 不可扭转"语义；部分成交增量记账无重复计数；减仓位豁免、超卖拒入+熔断均有测试锚定；无私钥入日志。
- **api/runtime**：signed-clob-client 全链路 fail-closed（SDK retry 禁用防歧义重复单、in-flight 去重、启动对账、AggregateError 不吞错、心跳防重入）；HTTP Bearer 用 SHA-256 digest + timingSafeEqual、非 loopback 强制 token、停机有界；graceful-shutdown 四路径有测试；entrypoint 异常兜底正确；index.ts 装配幂等、订阅成对注销、liveTrading 三重门；定时器全部成对 clear + unref。
- **基建**：CI 真实有效（typecheck/lint/format/knip/test/build/双 smoke + secret 扫描）；供应链固定（Actions 按 SHA、镜像按 digest、`npm ci --ignore-scripts`、provenance）；生产容器非 root/read_only/cap_drop；zod 配置 fail-closed；runtime-config 交叉校验严谨；docs 抽查 5 处全部属实。

## 9. 修复优先级建议

**P0 — 放开任何实盘门控前必须修**（当前 paper-only 下无即时风险）：

1. EXEC-1（风控拒绝误触熔断）
2. MKT-1（快照-增量门控）+ API-12（staleness 门槛）
3. API-1（重连耗尽通知）+ API-3/API-4（user-ws/market-ws 重连测试）
4. API-2（市价单 price=0 与启动对账锁死）
5. EXEC-4（陈旧锁回收，4 处同模式）

**P1 — 数学正确性（公共 API 说谎，启用策略交易前必须修）**：

6. CORE-1（bregman θ 初始化）、CORE-2/CORE-3（LMO 结构验证 + 结构化 fallback）
7. OPT-1（unbounded 检测）、OPT-2（B&B 界约束分支）、OPT-3、OPT-4、OPT-5
8. EXEC-2/EXEC-3（Kelly 卖出腿 + 单位统一）

**P2 — 语义/可观测性**：CORE-4/5/6/7/9、EXEC-5/6/7、INFRA-2/3/4/5、OPT-6/7。

**P3 — 测试补强（贯穿所有修复）**：为每个算法件加"已知闭式最优解"数值锚定测试（CORE-8、OPT-10、EXEC-8）；把 /tmp 的 skip-list/order-book 随机差分测试固化（MKT-9）；每个 P0/P1 修复必须附带能复现原 bug 的回归测试。

## 10. 协作约定（给接手的 AI agent）

1. **先跑基线**：`npm run typecheck && npm test`，确认 1162 全绿再动手；修复后必须保持全绿并新增回归测试。
2. **不要重复审计** §8 列出的已验证正确部分，除非改动涉及其接口。
3. **引用本文档发现时按 ID**（如"修复 OPT-2"），完成后在对应条目末尾标注 `✅ 已修复（commit/日期）` 或 `❌ 已确认不修（原因）`，保持文档为活的状态台账。
4. **禁止事项**：读取/修改 `.env`；任何 git 变更操作需用户显式批准；不向仓库写临时实验脚本（用 /tmp + 编译产物验证）。
5. **代码风格**：ESM + `.js` 导入后缀；注释与提交信息用英文（遵循仓库惯例）；`npm run lint && npm run format:check` 需通过；pre-commit/pre-push hook 会强制执行。
6. **验证数学修复时**：构造已知闭式最优解的小问题做对照（参考本文档各发现的实证反例，可直接改造为测试）。
7. **语义红线**：KL 散度/阈值是 nats 单位的不一致性诊断量，**不是美元利润**；任何命名/注释不得再引入 "guaranteedProfit = divergence" 的误解（见 CORE-9）。
8. 本文档之外的背景：`docs/core-algorithm-theory-guide.md`（算法推导）、`docs/live-trading-readiness.md`（实盘门控清单）、`docs/architecture.md`。

---

*审查方法说明：6 个专项审查（core 数学 / optimization / market / execution / api+runtime / 基建）分别精读全部源码，配合 jest 定向测试与 /tmp 独立数值实验（含已知最优解对照、暴力枚举反例、16 万次随机差分测试）；其中 5 处严重/高发现（CORE-1/2/3、OPT-1/2、EXEC-1）已经第二位审查者人工核对源码确认。*
