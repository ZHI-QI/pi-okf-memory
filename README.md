# dsh-okf-memory

[English](README.en.md) | 简体中文

**会话记忆 → OKF 知识沉淀插件(神经自我学习驱动)**

把会话中高价值内容按 [OKF v0.1](https://github.com/open-knowledge-format) 规范自动沉淀为长期记忆,跨会话自动唤起。Agent 越用越准:每次选择、跳过、纠错都是学习信号,记忆权重持续更新。

**Session-to-OKF memory plugin with neuro-self-learning: predictive recall, uncertainty-driven capture, reinforcement feedback, consolidation & forgetting.**

![记忆图谱 · 神经自我学习](docs/okf-memory-banner.png)

[![dshfind](https://dshfind.com/api/card/ZHI-QI/dsh-okf-memory?lang=zh)](https://dshfind.com/zh/plugins/ZHI-QI/dsh-okf-memory?ref=badge)

## 特性

- **记忆四阶段闭环**:捕获 → 概念化 → 沉淀 → 唤起
- **OKF v0.1 合规**:每个概念是标准 Markdown 文档(frontmatter 硬要求 `type`),`index.md` 渐进式目录 + `log.md` 变更历史,交叉链接用包内绝对路径
- **神经自我学习驱动**:预测性唤起(先预测再检索校验)、不确定性量化(置信低扩大探索)、预测误差驱动捕获(用户纠正/首次披露触发写入)、权重衰减+归档(巩固与遗忘)
- **强化反馈回路**:`score = relevance × weight × recency`,用户选中候选权重↑、跳过权重↓
- **技术选型记忆(TechChoice)**:前端/后端/语言/方案/配置 按维度沉淀候选表 + 当前使用;三档选择规则(多候选展示、单候选直用、领域命中按维度)
- **写入许可门**:type 合法性 → 去重(互补不复制,互建交叉链接)→ OKF 符合性校验
- **记忆图谱可视化(M2)**:client 面板在 DSH 对话视图渲染**力导向记忆图谱**——节点大小=权重、颜色=类型;搜索命中→脉冲光环+⚡命中+神经传导;滚轮缩放/拖拽平移/拖节点/悬停详情
- **图谱数据接口**:`okf_graph` 工具 + `service.graph` 输出 `{nodes,edges,timeline}` JSON,契约稳定,可被任意前端复用

## 安装

```sh
# 任意 profile(如 web):已发布到 npm,一行安装,免构建授权
dsh plugin --profile web add dsh-okf-memory
# 或从本地 checkout(开发用):
dsh plugin --profile web add ./dsh-okf-memory
# 或从 GitHub 源码(需 prepare 构建并向用户授权构建):
dsh plugin --profile web add github:ZHI-QI/dsh-okf-memory
```

**已发布到 npm**:`dsh-okf-memory@0.1.0` → https://www.npmjs.com/package/dsh-okf-memory

插件零运行时依赖(peer 依赖 `@deepseek-ai/cordis` 由 dsh 运行时提供,安装时若有 peer 警告可忽略),安装即用,无需构建脚本。

## 也支持 pi(双运行时)

同一份核心(`src/server/*`,零运行时依赖、零宿主耦合)同时驱动 dsh 与 [pi](https://pi.dev) 两个宿主:

| | dsh | pi |
|---|---|---|
| 适配层入口 | `src/server/index.ts`(配 `cordis.patch.yml`) | `src/pi/index.ts`(`package.json` 的 `pi.extensions`) |
| 默认记忆库 | `~/.dsh/memory/` | `~/.pi/agent/okf-memory/` |
| 提示注入 | `ctx.systemPrompt.section()` | `pi.on("before_agent_start")` → `systemPrompt` |
| 图谱展示 | web 对话视图标签(client-plugin + `/okf-graph` 路由) | `/memory-graph` 导出自包含 HTML 并开浏览器 |
| 工具数 | 5 | 6(多一个 `okf_feedback`) |

两个宿主都认 `OKF_MEMORY_ROOT` 环境变量 —— 指向同一个目录即可共享记忆库。

### 安装(pi)

```sh
pi -e ./dsh-okf-memory/src/pi/index.ts   # 试用,不写任何配置
pi install ./dsh-okf-memory              # 安装(读 package.json 的 pi 字段)
```

装好后同样无需手敲命令:插件经 `before_agent_start` 注入「记忆纪律」+ 库摘要,Agent 自主判断该记什么、该查什么。

### pi 侧命令

| 命令 | 作用 |
|---|---|
| `/memory` | 记忆库状态(根目录 / 概念数 / 权重榜) |
| `/memory-search <关键词>` | 终端内检索(按 相关度 × 权重 × 近因 排序) |
| `/memory-graph` | 导出交互式记忆图谱 HTML 并用浏览器打开 |
| `/memory-consolidate` | 立即执行一次巩固(权重衰减 + 归档) |

![记忆图谱·pi 侧搜索命中与神经传导](docs/记忆图谱-demo.png)

`/memory-graph` 生成的 HTML 是**单文件自包含**的(无 CDN、无构建产物),可直接双击打开或分享。
节点大小=权重、颜色=类型、虚线描边=已归档;搜索命中节点描白边 + 脉冲光环 + `⚡命中`,
并沿交叉链接 BFS 传导点亮关联节点。

### 为什么 pi 侧不需要构建

pi 用 [jiti](https://github.com/unjs/jiti) 直接加载 TypeScript,并为扩展提供 `typebox`、
`@earendil-works/pi-*` 等别名,所以 `src/pi/index.ts` 与 `src/server/*.ts` 可被**源码直载** ——
无构建步骤、无运行时依赖(`tsdown` 仅为 dsh 侧产物与 npm 发布保留)。

### pi 侧新增的 `okf_feedback`

dsh 侧的 `recordSelect`(+1.0)与 `recordSkip`(−0.5)此前**没有任何调用入口**(死代码),
导致 README 承诺的「选中权重↑ / 跳过权重↓」实际只有正向的 `okf_read`(+0.1)在生效。
pi 侧补齐了这个缺口:

```
okf_feedback(concept_id="techchoice/前端方案", action="select")  # 用户拍板 → 权重 +1.0
okf_feedback(concept_id="fact/某条", action="skip")           # 用户否定 → 权重 −0.5
```

## 如何使用

装好后你**无需手敲命令**。插件会给 Agent 注入一段「记忆纪律」系统提示,让它在会话里**自主判断**该记什么、该查什么,并调用下面的工具完成。你也可以随时显式地说「记住XX」或「查一下记忆里关于XX的」来主动触发。

### 5 个工具一览

| 工具 | 作用 | 什么时候用 |
|---|---|---|
| `okf_remember` | 写入一条记忆(自动去重、校验、落盘) | 有值得沉淀的新知识时 |
| `okf_search` | 按关键词召回,按权重/近因排序 | 开场预取、回答前找相关记忆 |
| `okf_read` | 精读某条全量(含交叉链接),并记录一次使用反馈 | 需要完整细节时 |
| `okf_forget` | 撤回一条记忆 | 记错 / 不需要时 |
| `okf_graph` | 导出记忆图谱 JSON(nodes/edges/timeline) | 可视化 / 传递图谱数据 |

### 让它记住(写入)

- **自动(推荐)**:你在对话里披露新事实、拍板决策、纠正 Agent、提到技术选型时,Agent 会**自己判断**是否值得记,不用你开口。
- **手动**:直接说「记住…」即可触发,例如 `记住,我的三家门店是韶山/湘乡/塘厦,共用局域网共享文件夹`。

**什么才算「值得记」**:新背景事实/偏好、决策及理由、可复用方法论/流程/经验教训、用户纠正、被确认的反直觉结论、技术选型。
**不记**:寒暄、单轮临时任务、已有记忆的重复内容、未验证的猜测(猜测归入 `Idea`,等成熟再沉淀)。

### 让它回忆(召回)

- 你问相关问题时,Agent 会先 `okf_search` 召回再作答。
- 也可显式说「查一下记忆里关于XX的」。
- **检索不到会明确告诉你「记忆库没有」,不会编造**。

### 技术选型怎么用(TechChoice)

针对前端/后端/语言/方案/配置这类选型,插件按「三档规则」处理(细节见下文「技术选型三档规则」专节):命中 2+ 候选 → 全部展示给你选;命中 1 个 → 直接用;你未指定技术但命中维度关键词(如「前端」)→ 按该维度记忆处理;你提出新方案/切换/配置 → 追加式更新,不覆盖旧候选。

### 示例:怎么记、怎么查

```text
// ① 记一条门店事实(Fact)
用户: 记住,我的三家门店是韶山/湘乡/塘厦,共用局域网共享文件夹
Agent: okf_remember(title="门店布局", type="Fact",
        content="# 核心\n\n三家门店共用局域网共享文件夹…", tags=["门店"])
       → 已沉淀记忆 fact/门店布局

// ② 记住前端方案(TechChoice)
用户: 前端就用 React 18 + Vite 吧
Agent: okf_remember(type="TechChoice", title="前端方案",
        content="## Options\n\n| 候选 | 状态 |\n|---|---|\n| React 18 + Vite | active |",
        tags=["前端","技术选型"])

// ③ 问数据库时先召回(而不是去翻本地文件)
用户: 帮我查询数据库
Agent: okf_search(query="查询数据库")
       → 命中「鼎赞数据统一用 mcp-dezensaas-mysql」
       → 按该记忆走 mcp-dezensaas-mysql 服务
```

## 视觉图谱(DSH 对话视图标签)

插件带有 `client-plugin`,在 DSH web 的对话视图注册一个「**记忆图谱**」标签:

- **力导向图谱**:节点大小=权重、颜色=类型(fact/preference/decision/method/insight/idea/lesson/techchoice)、连线=交叉链接
- **搜索命中**:顶部输入框命中 title/type/tags → 命中节点白色描边 + 脉冲光环 + `⚡命中`,并 BFS 传导激活相关节点
- **交互**:滚轮缩放、拖拽平移、拖节点、悬停查看详情(标题/类型/权重/描述/标签)

数据来自后端 `/okf-graph` 路由(webServer,仅 web profile),由 `okf_graph` 工具 / `service.graph` 提供。

## 记忆库结构

默认 `~/.dsh/memory/`(环境变量 `OKF_MEMORY_ROOT` 覆盖):

```
~/.dsh/memory/
├── index.md              ← 渐进式目录(okf_version: "0.1")
├── log.md                ← 变更历史(## YYYY-MM-DD)
├── fact/                 ← Fact 背景事实
├── preference/           ← Preference 用户偏好
├── decision/             ← Decision 决策(三段式:数据/分析/结论)
├── method/               ← Method 方法论
├── insight/              ← Insight 洞察
├── idea/                 ← Idea 未成型灵感
├── lesson/               ← Lesson 经验教训
├── techchoice/           ← TechChoice 技术选型(Options 候选表 + Active)
└── .meta/weights.json    ← 学习权重元数据(不污染 OKF 符合性)
```

## 技术选型三档规则(用户既定协议)

1. 命中 2+ 候选 → **全部展示给用户选择**,不擅自决定
2. 命中 1 个候选 → 直接使用
3. 用户未指定技术但命中维度关键词(如"前端")→ 按该维度记忆处理
4. 用户说出新技术/切换/配置 → 追加式更新,不覆盖旧候选(保留 v1→vN 迭代轨迹)

## 配置

| 项 | 方式 | 默认 |
|---|---|---|
| 记忆库根目录 | 环境变量 `OKF_MEMORY_ROOT` 或 settings `okfMemory.root` | `~/.dsh/memory/` |
| 学习参数 | `lib/learning.js` 中 `PARAMS`(衰减天数/归档阈值等) | 见文件 |

## 开发与测试

```sh
npm test                      # 全量:typecheck + build + 6 套件(236 断言)
npm run typecheck             # 仅类型检查(tsc --noEmit,对账 pi 真实 .d.ts)
npm run test:core             # 仅核心模块(smoke + concurrency + regression)
npm run test:dsh              # 仅 dsh 侧(build + integration + schema-check)
npm run test:pi               # 仅 pi 侧(typecheck + 96 断言)

node scripts/smoke.js         # 核心模块功能验证(含并发写锁断言)
node scripts/integration.js   # mock dsh ctx 集成验证(含错误路径断言)
node scripts/schema-check.js  # dsh 工具 schema 合规
node scripts/concurrency.js   # 写锁并发压测(50 并行写 / 5 并行反馈)
node scripts/regression.js    # P0 回归:锁可重入/异常恢复、merge 边界、路径穿越、forget 幂等、巩固幂等
node scripts/pi-integration.js # mock pi ExtensionAPI:工具/命令/提示注入/schema 校验/图谱 HTML
```

`pi-integration.js` 用 jiti 加载 `src/pi/index.ts`(与 pi 自身的扩展加载方式一致),
不需要先 `build`。

### 为什么需要单独的 `typecheck`

`tsdown`(rolldown) **只剥离类型、不做类型检查**,所以 `pnpm build` 通过 ≠ 类型正确。
项目历史上从未跑过 `tsc`,存有若干陈旧类型缺陷(如 `RankableHit` 的索引签名导致
`SearchHit` 不可赋值、`refreshIndex` 的 `metas[i].description` 报错)。
现以 `tsconfig.typecheck.json` 固定检查 `src/server` + `src/pi`( `src/client` 依赖 dsh web 运行时,不在范围内),
对账 **pi 的真实 `.d.ts`** —— 这正是自适应层 API 用法是否正确的权威依据,
比自写 mock 更可靠(mock 只能证明「符合我对 API 的假设」)。

## License

MIT

## 测试层级（为什么是这几层）

| 层 | 命令 | 需要 | 证明什么 |
|---|---|---|---|
| 类型对账 | `pnpm typecheck` | — | 适配层用法符合 **pi 真实 `.d.ts`** |
| 核心功能 | `scripts/smoke.js` | — | store/concept/dedupe/learning/recall/graph |
| dsh 集成 | `scripts/integration.js` | — | mock dsh ctx 下的 5 工具全链路 |
| pi 集成 | `scripts/pi-integration.js` | — | mock pi API 下的 6 工具 + 4 命令 + schema 校验 |
| **pi 真实 RPC** | `scripts/pi-rpc-commands.js` | `pi` 在 PATH | 命令真的被**真实 pi 进程**识别并执行 |
| **真实模型端到端** | `pnpm test:e2e` | 模型凭据 | 模型真的调工具、真的落盘、真的跨会话召回 |

`pnpm test` 跑前五层（离线、确定性）。第六层要花 token，故单独：

```sh
pnpm test:e2e                                  # 默认 deepseek/deepseek-flash
OKF_MODEL=zai-coding-cn/glm-5.3-flash pnpm test:e2e
```

**为什么必须有第六层**：mock 不会自己决定传什么参数。本项目真实端到端跑出的第一个 bug 就是——
模型从不知道要传 `related` 参数，于是**真实使用下图谱永远是零边的孤岛**，而机制单测是绿的。
