# Polymarket 核心算法完整讲解（推导 + 代码）

本文面向“想真正看懂项目算法”的读者。目标是把本项目里的核心优化链路讲透：

1. 如何把跨市场套利写成凸优化问题
2. Frank-Wolfe 每一步在数学上做了什么
3. LMO（线性最小化 Oracle）为什么这样实现
4. Bregman 投影（IPF）更新式从哪里来
5. `guaranteedProfit = objective - gap` 的含义
6. 如何用项目里的 API 跑一个完整示例

---

## 1. 问题建模：把市场价格变成优化问题

设有 `n` 个市场（或 outcome 维度），价格向量记为：

$$
\theta = (\theta_1,\dots,\theta_n),\quad \theta_i \ge 0
$$

我们要求一个“可行概率/头寸向量” $\mu$，它必须满足边际多面体约束（可行域）：

$$
\mu \in \mathcal{M}
$$

在本项目中，$\mathcal{M}$ 由以下约束构造（见 `src/core/marginal-polytope.ts`）：

1. 事件等式约束：每个事件内 outcome 概率和为 1  
   例如某事件有 `YES/NO`，则 $\mu_{\text{YES}}+\mu_{\text{NO}}=1$
2. 非负约束：$\mu_i \ge 0$
3. 上界约束：$\mu_i \le 1$

对应代码入口：

- 约束构造：`src/core/marginal-polytope.ts`
- 可行性检查：`src/core/marginal-polytope.ts`

### 为什么用于 Polymarket 交易

Polymarket 的核心对象就是事件与 outcome（典型是 `YES/NO`）的概率价格。交易上真正要满足的是“同一事件内部概率一致性”和“概率边界合法性”。  
把问题先写成 $\mu\in\mathcal{M}$ 有两个直接好处：

1. 先验保证交易向量是可行组合，不会产出逻辑上冲突的头寸。
2. 多市场联动时，约束统一在一个几何对象里表达，便于后续优化器一次性处理。

---

## 2. 目标函数：KL 与广义 KL

项目中出现两类散度：

1. 标准 KL（归一化概率分布）

$$
D_{\mathrm{KL}}(\mu\|\theta)=\sum_i \mu_i\log\frac{\mu_i}{\theta_i}
$$

2. 广义 KL（非归一化非负向量也可用）

$$
D_{\mathrm{GKL}}(\mu\|\theta)=\sum_i\left[\mu_i\log\frac{\mu_i}{\theta_i}-\mu_i+\theta_i\right]
$$

在跨市场套利场景里，本项目主路径使用广义 KL（见 `src/market/arbitrage-detector.ts` 与 `src/strategies/cross-market-arbitrage.ts`）。

### 2.1 梯度推导

对单维项

$$
f_i(\mu_i)=\mu_i\log\frac{\mu_i}{\theta_i}-\mu_i+\theta_i
$$

求导：

$$
\frac{\partial f_i}{\partial \mu_i}=\log\frac{\mu_i}{\theta_i}
$$

所以广义 KL 梯度为：

$$
\nabla_i D_{\mathrm{GKL}}(\mu\|\theta)=\log\frac{\mu_i}{\theta_i}
$$

这正是检测器中的梯度实现（见 `src/market/arbitrage-detector.ts:257`）。

若是标准 KL，则梯度是：

$$
\nabla_i D_{\mathrm{KL}}(\mu\|\theta)=\log\frac{\mu_i}{\theta_i}+1
$$

对应代码：`src/core/bregman-projection.ts:252`。

### 为什么用于 Polymarket 交易

Polymarket 的价格向量经常不是“全局归一化分布”，但它们是非负且有相对价格信息。  
广义 KL 的优势是：

1. 对未归一化非负向量依然定义良好，和跨市场数据形态匹配。
2. 对数比值梯度 $\log(\mu_i/\theta_i)$ 会放大“相对错价”而不是绝对差值，更适合赔率/概率型市场。
3. 在 $\mu_i,\theta_i>0$ 时数值稳定、可微，方便实时迭代优化。

---

## 3. Frank-Wolfe 主算法推导

我们求解：

$$
\min_{\mu\in\mathcal{M}} f(\mu)
$$

其中 $f$ 是 KL 或广义 KL。

Frank-Wolfe（条件梯度）每轮迭代：

1. 在当前点 $\mu_t$ 计算梯度 $g_t=\nabla f(\mu_t)$
2. 解线性子问题（LMO）：

$$
s_t=\arg\min_{s\in\mathcal{M}}\langle g_t,s\rangle
$$

3. 沿线段更新：

$$
\mu_{t+1}=(1-\gamma_t)\mu_t+\gamma_t s_t,\quad \gamma_t\in[0,1]
$$

### 3.1 Frank-Wolfe gap（最优性度量）

定义：

$$
\mathrm{gap}_t=\langle g_t,\mu_t-s_t\rangle
$$

对凸可微问题有：

$$
f(\mu_t)-f^\star \le \mathrm{gap}_t
$$

所以 gap 可作为“距离最优”的上界估计。gap 越小，离最优越近。

对应代码：

- gap 计算：`src/core/frank-wolfe.ts:144`
- 收敛判断：`src/core/frank-wolfe.ts:152`

### 3.2 本项目收敛判据（实现细节）

项目使用了缩放阈值：

$$
\mathrm{gap} \le \text{tolerance}\cdot(1-\alpha)\cdot\max(1,|f(\mu)|)
$$

其中 $\alpha=\texttt{ALGORITHM\_CONFIG.ALPHA}$（默认 `0.9`，见 `src/utils/config-schema.ts:16`）。

这使阈值随目标量级变化，避免目标值很大/很小时固定阈值不稳定。

### 为什么用于 Polymarket 交易

Polymarket 实时交易要求“快且可解释”。Frank-Wolfe 在这个场景适配性强：

1. 每轮只需梯度 + 一个 LMO，避免昂贵投影，延迟可控。
2. 迭代始终在可行域凸组合上更新，减少策略层后处理。
3. `gap` 提供可解释停止信号，可直接映射到“还剩多少可优化空间”。
4. 缩放收敛阈值让不同市场波动/量级下的停止条件更稳。

---

## 4. LMO 推导：为什么“每个等式组里选最小梯度坐标”

当可行域是“多个独立 simplex 的直积”（本项目常见场景），每个组满足：

$$
\sum_{i\in G_k} a_i\mu_i=b_k,\quad \mu_i\ge 0
$$

LMO 子问题是线性规划：

$$
\min \sum_i g_i \mu_i
$$

在线性目标 + simplex 约束下，最优解落在顶点，等价于“每组只激活一个坐标”。  
若系数是 $a_i$，组内比较的是 $g_i/a_i$，选最小者并令：

$$
\mu_{i^\star}=\frac{b_k}{a_{i^\star}}
$$

这就是 `linearMinimizationOracle` 的核心逻辑（`src/core/lmo.ts:60`）。

### 为什么用于 Polymarket 交易

Polymarket 常见结构是“多个事件组并行存在”，每组内部是 simplex 约束。  
这时 LMO 可分组独立求解，业务价值很直接：

1. 复杂高维问题被拆成小组最优选择，速度快。
2. 每组只激活最优坐标，等价于“在该事件上先选最有优势的一侧”。
3. 适配实时扫描：市场数量上来后仍能保持低开销。

---

## 5. 步长推导与实现：为何用真实目标 golden-section

FW 需要解一维问题：

$$
\gamma_t=\arg\min_{\gamma\in[0,1]} \phi(\gamma),\quad
\phi(\gamma)=f\big((1-\gamma)\mu_t+\gamma s_t\big)
$$

由于 $f$ 凸，$\phi$ 是一维凸函数。项目采用黄金分割搜索（无需导数，鲁棒）：

- 实现：`src/core/line-search.ts:35`
- 默认 FW `stepSize='line-search'`（`src/core/frank-wolfe.ts:173`）

另有 `lineSearchKL` 作为“无目标函数时的近似退化方案”（`src/core/line-search.ts:18`）。

### 为什么用于 Polymarket 交易

Polymarket 盘口会快速变化，错误步长会导致“该走的收益没吃到，或走过头”。  
用真实目标线搜索的意义是：

1. 每一步都按真实交易目标（散度）选步长，减少启发式误差。
2. 黄金分割不依赖二阶信息，面对噪声数据更稳健。
3. 在实时场景里比复杂二阶法更轻量，同时比固定步长更可靠。

---

## 6. Bregman 投影（IPF）推导

目标：

$$
\min_{\mu\in\mathcal{M}} D_{\mathrm{KL}}(\mu\|\theta)
$$

若只看一条等式约束 $\sum_i c_i\mu_i=r$，I-projection 的乘法更新可写成：

$$
\mu_i \leftarrow \mu_i\cdot \left(\frac{r}{\sum_j c_j\mu_j}\right)^{c_i}
$$

直观上，这是按“当前约束偏差比例”做指数缩放，使该约束被拉回目标值。  
项目实现正是这个更新（`src/core/bregman-projection.ts:101`）：

1. 预处理稀疏等式约束（仅非零项）
2. 对每个约束做乘法更新
3. 全局归一化
4. 用 $\|\mu^{(t+1)}-\mu^{(t)}\|_2$ 检查收敛

### 为什么用于 Polymarket 交易

现实交易里，抓到错价后需要一个“离当前价格近、但满足约束”的可执行目标点。  
Bregman/IPF 在 Polymarket 的价值是：

1. 通过乘法更新保持非负，天然匹配概率变量。
2. 稀疏约束迭代能在多市场下保持可接受延迟。
3. 输出是“约束一致的最近点”，可直接转成交易方向（`mu - price`）。

---

## 7. `objective - gap` 为什么可当“保守可提取收益”

在最小化问题中：

$$
f^\star \ge f(\mu_t)-\mathrm{gap}_t
$$

即 `current objective - gap` 是“最优值的下界”。  
项目把最优散度解释为可提取套利强度，因此定义：

$$
\texttt{guaranteedProfit} \approx \texttt{objective} - \texttt{gap}
$$

对应代码：

- `src/core/arbitrage-utils.ts:21`
- `src/market/arbitrage-detector.ts:153`

注意：这是算法下界意义上的“保守估计”，真实成交收益还会受滑点、深度和执行延迟影响。

### 为什么用于 Polymarket 交易

Polymarket 执行层面最怕“纸面套利，落地亏损”。  
用 `objective - gap` 作为保守门槛的意义是：

1. 把优化误差显式扣掉，降低假阳性机会。
2. 可直接与最小收益阈值对接（如 `MIN_PROFIT_THRESHOLD`），便于自动化交易决策。
3. 在成交不确定（滑点/排队）下，先用下界筛选更安全。

---

## 8. 手算一个最小示例（2 维 YES/NO）

假设某事件：

$$
\theta=[0.7,\,0.4],\quad \mu_0=[0.5,\,0.5],\quad \mu_1+\mu_2=1
$$

目标是最小化广义 KL。

### 8.1 第 0 轮梯度

$$
g_0=\left[\log\frac{0.5}{0.7},\log\frac{0.5}{0.4}\right]\approx[-0.336,\ 0.223]
$$

### 8.2 LMO 选顶点

最小梯度在第一维，故

$$
s_0=[1,0]
$$

### 8.3 gap

$$
\mathrm{gap}_0=\langle g_0,\mu_0-s_0\rangle
=(-0.336)(-0.5)+(0.223)(0.5)\approx0.279
$$

### 8.4 取一个步长（示意）

若取 $\gamma=0.2$：

$$
\mu_1=(1-0.2)\mu_0+0.2s_0=[0.6,0.4]
$$

对比目标值：

- $f(\mu_0)\approx0.043$
- $f(\mu_1)\approx0.008$

目标下降，方向正确。

---

## 9. 与源码的逐项映射

| 数学对象 | 代码实现 |
|---|---|
| 可行域 $\mathcal{M}$（等式/不等式约束） | `src/core/marginal-polytope.ts` |
| LMO：$\arg\min\langle g,s\rangle$ | `src/core/lmo.ts` |
| FW 主循环 | `src/core/frank-wolfe.ts` |
| gap 与收敛判据 | `src/core/frank-wolfe.ts:144`, `src/core/frank-wolfe.ts:152` |
| 线搜索（真实目标） | `src/core/line-search.ts:35` |
| 广义 KL 与向量算子 | `src/utils/math.ts:145` |
| Bregman/IPF 投影 | `src/core/bregman-projection.ts` |
| 套利判定与交易向量 | `src/core/arbitrage-utils.ts` |

---

## 10. 可运行 TypeScript 示例代码

下面示例演示“约束 + 广义 KL + Frank-Wolfe + 交易方向”完整流程。

```typescript
import {
  frankWolfe,
  linearMinimizationOracle,
  computeTradeRecommendation,
  isProfitableArbitrage,
} from '../src/core/frank-wolfe.js';
import { generalizedKLDivergence } from '../src/utils/math.js';
import type { Constraint } from '../src/core/frank-wolfe-types.js';

// 两个独立事件，每个事件是 YES/NO 一组
// Group A: mu0 + mu1 = 1
// Group B: mu2 + mu3 = 1
const constraints: Constraint[] = [
  { coefficients: [1, 1, 0, 0], rhs: 1, type: 'equality' },
  { coefficients: [0, 0, 1, 1], rhs: 1, type: 'equality' },
];

// 市场价格（可不归一化）
const theta = [0.78, 0.30, 0.18, 0.92];

// 初始点必须可行：每组和为 1
const initialMu = [0.5, 0.5, 0.5, 0.5];

const epsilon = 1e-10;
const objectiveFn = (mu: number[] | Float64Array): number =>
  generalizedKLDivergence(Array.from(mu), theta);

const gradientFn = (mu: number[] | Float64Array): number[] =>
  Array.from(mu).map((m, i) => {
    const safeMu = Math.max(m, epsilon);
    const safeTheta = Math.max(theta[i] ?? epsilon, epsilon);
    return Math.log(safeMu / safeTheta); // generalized KL gradient
  });

const lmoFn = (grad: number[] | Float64Array): number[] =>
  linearMinimizationOracle(Array.from(grad), constraints);

const result = frankWolfe(initialMu, objectiveFn, gradientFn, lmoFn, {
  maxIterations: 150,
  tolerance: 1e-6,
  stepSize: 'line-search',
});

const trade = computeTradeRecommendation(result, theta);
const profitable = isProfitableArbitrage(result, 0.01);

console.log('FW result:', result);
console.log('trade vector (mu - theta):', trade);
console.log('profitable?', profitable);
console.log('guaranteedProfit ~= objective - gap =', result.objective - result.gap);
```

运行建议：

```bash
npm test -- tests/core/frank-wolfe.test.ts
npm test -- tests/core/bregman-projection.test.ts
```

你也可以直接参考现成测试：

- `tests/core/frank-wolfe.test.ts`
- `tests/core/bregman-projection.test.ts`

---

## 11. 进阶理解：本实现的边界与假设

1. `linearMinimizationOracle` 主要针对“独立等式组（product-of-simplex）”场景，通用耦合约束下需要更一般 LP LMO。
2. `MarginalPolytope.project()` 是轻量化可行化逻辑（按事件归一 + clip），不是全约束精确投影器。
3. `bregmanProjection()` 只使用了等式约束的稀疏正系数部分，复杂不等式体系要靠外层优化流程处理。
4. `guaranteedProfit` 是优化意义的保守下界，不是撮合后的最终 PnL。

---

## 12. 建议的学习顺序

1. 先读 `src/core/frank-wolfe.ts`，把迭代框架看懂。
2. 再读 `src/core/lmo.ts`，理解“为什么每组挑一个顶点”。
3. 再读 `src/core/line-search.ts`，理解真实目标线搜索。
4. 然后读 `src/core/bregman-projection.ts`，把 IPF 与 KL 梯度对上。
5. 最后看 `src/market/arbitrage-detector.ts`，把数学对象与业务对象对应起来。

完成这五步后，你基本就能独立修改这条算法链。

---

## 13. 独立章节：为什么在 Polymarket 交易中需要这套算法

你提到“要一个集中、完整的理由链条”，这里给出从交易现实到算法选择的闭环论证。

### 13.1 先看交易现实：Polymarket 不是单市场静态定价

在 Polymarket 做套利，通常同时面对四个事实：

1. 市场是分散的  
同一主题可能拆成多个相关市场，信息传播速度不一致，出现短暂错价。
2. 约束是结构化的  
例如同一事件内 `YES + NO = 1`，跨事件还可能有互斥或条件关系。
3. 数据是实时变化的  
盘口、深度、成交在秒级甚至更快变化，算法必须“快收敛 + 可中断”。
4. 执行有摩擦  
滑点、深度不足、排队与延迟会吞掉理论利润，必须用保守指标做筛选。

结论：这不是“拍脑袋买卖”问题，而是“带约束的实时优化”问题。

### 13.2 为什么不是简单规则引擎

规则法在单市场上有效，但在跨市场组合上会迅速失效：

1. 规则难以覆盖高维关系  
两三个市场还能人工写规则，十几个市场后组合数爆炸。
2. 规则无法自动平衡多约束  
满足某个事件约束时，可能破坏另一个事件组的可行性。
3. 规则很难输出“最优交易量向量”  
通常只能告诉你“有机会”，但不能稳定给出可执行头寸。

所以需要一个能同时处理“约束 + 目标 + 规模”的统一数学框架。

### 13.3 为什么需要“边际多面体建模”

边际多面体（可行域）本质上解决的是“交易向量合法性”问题。

在 Polymarket 中，这一步不是可选项，而是安全底座：

1. 把概率一致性写成硬约束  
例如事件内和为 1，避免产生逻辑冲突头寸。
2. 把边界条件写成硬约束  
保证 `0 <= mu_i <= 1`，避免出现无意义信号。
3. 给后续优化提供统一几何空间  
后续的任何收益度量都在同一可行域中比较，结果可解释且可落地。

没有这一步，后续“利润信号”很容易来自不可执行点。

### 13.4 为什么需要 KL / 广义 KL 作为目标

Polymarket 报价是概率/赔率语义，核心是“相对偏差”而不是“绝对差值”。  
KL 类目标正好抓住这一点：

1. 对数比值强调相对错价  
`0.1 -> 0.2` 和 `0.5 -> 0.6` 的交易意义不同，KL 能区分。
2. 与概率变量自然匹配  
变量非负、常靠近边界，KL 在这种空间中有稳定解释。
3. 广义 KL 适配跨市场未归一化向量  
现实中组合价格向量不一定全局和为 1，广义 KL 更贴近实际输入。

因此 KL 类目标既有理论合理性，也贴合 Polymarket 数据形态。

### 13.5 为什么需要 Frank-Wolfe（而不是重投影型方法）

实时交易里，优化器的第一要求不是“最漂亮的数学收敛率”，而是“单位时间内稳定可用”。  
Frank-Wolfe 在这里的优势很关键：

1. 每轮计算轻  
核心是梯度 + LMO，避免复杂投影子问题。
2. 迭代点天然是可行凸组合  
减少“先算出非法解再修复”的额外延迟与风险。
3. 可随时早停  
`gap` 给出当前误差上界，适合流式数据下的时间预算控制。
4. 与本项目约束结构匹配  
当约束近似 product-of-simplex 时，LMO 可分组高效求解。

换言之：Frank-Wolfe 是在“速度、可行性、可解释性”三者之间的工程最优点。

### 13.6 为什么需要真实目标线搜索

固定步长在平稳数据上可用，但 Polymarket 的波动会让固定步长频繁失配。  
真实目标线搜索（golden-section）解决的是“每步到底走多远”：

1. 直接优化真实目标，不依赖局部二阶近似是否靠谱。
2. 减少走过头或走不够导致的收益损失。
3. 面对噪声盘口仍保持稳定，因为方法本身对导数噪声不敏感。

这一步提升的是实盘稳健性，不只是数学美观。

### 13.7 为什么还需要 Bregman 投影

Frank-Wolfe 是主优化链路，Bregman/IPF 主要承担“可行化与最近一致点”角色。

在 Polymarket 中它解决两个实际问题：

1. 当原始价格向量带噪声或轻微不一致时，快速拉回约束域。
2. 给执行层一个“离市场最近、但自洽”的目标分布，便于形成 `trade = mu - price`。

它像一个“约束一致性修复器”，提升交易指令的可执行性。

### 13.8 为什么要用 `objective - gap` 做保守收益门槛

实盘里最危险的是“模型显示有利差，但成交后没利润”。  
`objective - gap` 的价值在于把优化不确定性显式扣除：

1. 防止只看理想目标值导致过度交易。
2. 可直接和策略阈值/风控阈值对接，形成自动过滤。
3. 在滑点与时延存在时，给出更保守的准入标准。

它不是保证最终 PnL 的公式，但能显著降低假阳性机会。

### 13.9 这套算法组合在 Polymarket 的分工

可以把整套方法看作一条流水线：

1. `Marginal Polytope`：定义“什么是合法交易解”
2. `KL / generalized KL`：定义“什么是值得追的错价”
3. `Frank-Wolfe + LMO + line search`：在时间预算内找到高质量可行解
4. `Bregman/IPF`：在需要时做一致性修复/可行化
5. `objective - gap`：把解转成保守交易门槛
6. `trade = mu - price`：输出可执行方向

这不是“为了用算法而用算法”，而是把 Polymarket 交易中的四个核心矛盾同时处理：

1. 复杂约束 vs 实时性
2. 理论机会 vs 可执行性
3. 收益追求 vs 风险保守
4. 多市场联动 vs 工程可维护性

### 13.10 什么时候这套方法会不够用

也要明确边界，避免过度自信：

1. 约束高度耦合且不是分组 simplex 时，当前 LMO 近似可能不足。
2. 流动性极薄、冲击成本主导时，纯散度目标会高估可兑现收益。
3. 成本模型（手续费、滑点、成交概率）未显式并入目标时，需要策略层再做二次筛选。

因此更完整的下一步通常是：把交易成本与成交概率显式并入优化目标或后验打分。
