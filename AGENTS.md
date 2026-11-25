# Repository Guidelines

Meterleaf 是独立 AI 用量账本，只读采集上游与本机用量并在本地计价与展示。

- 产品入口：[README](README.md)
- 架构与数据流：[整体架构](docs/architecture.md)
- 界面设计规范：[视觉设计](DESIGN.md)
- 账务与使用：[使用与报表](docs/reporting.md) · [计价说明](docs/pricing.md)
- 采集与部署：[本机采集器](docs/collector.md) · [采集器辅助脚本](docs/collector-tasks.md) · [接入 CPA](docs/cpa.md) · [部署指南](docs/deployment.md) · [版本与发布](docs/releasing.md)

恢复工作时，读取当前任务实际引用的记录及必要设计、证据；没有记录时依据当前上下文继续。新的恢复记录可保存到 `.workbench/tasks/`。

## 目录地图与领域不变量

- `src/connectors`：Sub2API 只读连接器；`src/collector`：macOS 本机采集器（Claude Code、Codex、OpenCode、Antigravity、omp、本机 OTEL 中继、额度摘要与额外任务调度）；`collectors/cpa`：独立可选 Python CPA 同步容器。
- `src/domain`：用量、计价与额度领域规则；`src/storage`：SQLite 事实账本与三类可重建索引/缓存；`src/server`：Fastify API、认证、同步与多线程报表服务；`src/shared`：跨端共享契约。
- `src/web` 与 `public`：React 界面与 PWA 静态资源；`prices`：声明式源表 `catalog.ts` 与生成的版本化费率 `meterleaf.json`；`scripts`：打包、资源预压缩、费率构建/对账、发布与本机辅助脚本；`tests`：测试；`docs`：中文文档。
- 领域模型与报表不得依赖 Sub2API SQL 或列名。用量与额度快照是独立能力；未知值不得补零，缓存与推理 Tokens 不得重复累计，网关扣费与独立估值必须区分。
- 普通输入、缓存读取、缓存写入、输出是互斥计量桶；推理 Tokens 是输出子集。上游金额、网关扣费、订阅等价 USD、标准 API USD 和历史 Credits 保留各自依据，不能互相冒充账单或按固定比例换算。估值绑定价格表修订、有效时间与实际来源；缺少字段或费率保留未计价。修改已入库的价格表内容必须递增版本，禁止复用同一修订标识。
- 累计用量、筛选时段和订阅周期分别计算。API 接入类型不能推断上游是否有订阅额度；额度窗口按有效快照判断，过期或未知不能沿用旧值。

## 开发与验证命令

使用 Bun 1.4.4 或更新版本，依赖变更提交 `bun.lock`；CPA 同步器测试使用 Python 3.11+（CI 为 3.12）。

- `bun install --frozen-lockfile`：按锁文件安装依赖。
- `bun run dev:demo`：启动可辨识的演示界面。
- `bun run dev:server` 与 `bun run dev`：分别启动真实后端与前端。
- `bun run typecheck`：检查 TypeScript 类型；`bun test tests`：运行 Bun 单元与集成测试。
- `python3 -m unittest discover -s collectors/cpa -p 'test_*.py' -v`：运行 CPA 同步器单元测试。
- `bun run build`：类型检查、构建前端、注入 SW 资源清单并生成 Brotli/Gzip 预压缩资源；`bun run start`：启动应用。
- `bun run collector`：从源码直接运行本机采集器命令行。
- `bun run prices:build` 与 `bun run prices:check`：从 `prices/catalog.ts` 生成 `prices/meterleaf.json`，以及与上游公开目录对账。
- `bun run build:collector`：构建采集器命令行与 macOS 验证用的 `dist/Meterleaf Dev.app`，应用标识与正式应用不同，不会接管本机已安装 Meterleaf 的后台任务。
- `bun run build:app`：构建用于安装的 `dist/Meterleaf.app`，只在替换「应用程序」中的 Meterleaf 时使用，装好后删掉 `dist` 里的这份，避免系统把后台任务解析到它。

## 代码风格与注释

- 使用 TypeScript、两空格缩进、双引号和分号；沿用附近代码结构。React 组件使用 PascalCase，函数与变量使用 camelCase。
- 使用 Prettier 检查或格式化所改文件，例如 `bunx prettier --check src/web/components/LedgerTable.tsx`；不顺带重排无关文件。
- 注释解释业务含义、边界条件、兼容策略及异步顺序，不复述语法。跨模块契约和非显然规则应有简短说明；自解释的局部代码不强加注释。
- 禁止“本次新增”“之前改为”等修改过程叙述；修改代码时同步清理失效注释。项目文档使用中文，标识符与第三方许可证原文不翻译。

## 文档规范

- 用自然、直接的中文回答“这是什么、怎么用、出问题怎么办”。少用术语、抽象名词和生硬缩写；必要术语第一次出现时解释。不要把代码实现翻译成说明书，也不要用空话凑篇幅。
- 按读者任务组织内容，描述当前用法，不按开发时间逐条追加功能、修复经过或验证记录。
- README 只保留产品定位、核心能力、截图、快速开始和文档入口；使用指南解释操作及结果；部署指南聚焦配置、安装、升级、备份与排障；系统结构与线程/存储机制留在 [整体架构](docs/architecture.md)。
- 改动时重写或合并相关段落，删除重复和过时内容；每条信息保持一个主要出处，用链接引用，不复制多份费率表或配置说明。
- 文档完成后检查命令、默认值、相对链接与截图；截图不包含域名、地址栏、凭据或未经授权的数据。

## 测试要求

- 单元与集成测试使用 Bun，命名为 `tests/*.test.ts` 与 `tests/*.test.tsx`；端到端冒烟脚本命名为 `tests/*.smoke.ts`；浏览器测试使用 Playwright，专项脚本通常命名为 `tests/*.browser.ts`。
- 修复问题时覆盖对应回归场景；计价、迁移和同步变更需验证未知值、幂等与失败恢复，不以虚构覆盖率作为门槛。
- 界面改动检查桌面、移动端和减少动态效果模式；`bun run test:browser` 通过 `METERLEAF_CDP_URL` 连接任务浏览器。截图放入已忽略的 `test-results`，视觉验收由维护者确认。
- 专项 `*.browser.ts` 脚本读写真实接口：
  - 需连接外部服务的脚本，先用 `METERLEAF_DEMO=true bun --no-env-file src/server/main.ts` 起演示后端，再用 `bun run dev` 起页面，`METERLEAF_TEST_URL` 指向该页面的任务标签。
  - `quota-estimate.browser.ts` 与 `collector-live-updates.browser.ts` 自带临时真实服务，只需要 `METERLEAF_CDP_URL`；`account-merge.browser.ts` 自带临时服务和无头浏览器，不需要外部 URL。这三者都从 `dist/web` 提供前端，运行前需先 `bun run build`。
- 浏览器测试使用独立任务标签；修改 `localStorage` 时与维护者预览页隔离 origin。CDP 连接放在有 `finally` 清理的脚本内，结束时撤销模拟并断开连接，不在长期 REPL 中遗留 Playwright 客户端；系统主题须在清理后再次刷新验证。
- 高保真参考与维护者已认可版本是视觉依据，修复前保留其可恢复位置和已知缺陷。代理预审按当前任务要求校对参考、导航和受影响状态，明确偏差先处理；预审通过与维护者最终接受分别记录。维护者接管验收时交出可访问版本和已知限制。
- 纯文档改动核对对应事实、相对链接、所改 Markdown 的 Prettier 检查与 `git diff --check`，不触发产品完整测试。

## 提交与 Pull Request

- 每次提交必须使用 `type(scope): summary`，type 和 scope 均不可省略。
- type 使用 `feat`、`fix`、`refactor`、`style`、`test`、`docs`、`build`、`chore` 等；scope 指明模块，例如 `fix(sync): preserve cursor after failed batch`。
- PR 说明用户可见变化、相关问题和验证结果；界面变更附截图，未验证项说明原因。

## 配置与协作边界

- 当前按 `.env.example` 通过环境变量配置来源，可连接一个 Sub2API 实例、通过 `METERLEAF_INGEST_KEYS` 接收本机采集器或 CPA 同步容器推送，并可选配置 OpenCode Go 与 Command Code 额度轮询（`METERLEAF_OPENCODE_GO_KEY`、`METERLEAF_COMMAND_CODE_KEY`）与 GitHub 登录允许名单；Sub2API、推送密钥与 Command Code Key 至少配置一项；来源管理界面和用户角色系统不在当前产品范围。
- 项目采用 Apache-2.0。凭据、真实账户数据、运行数据库、机器路径及构建产物不得进入公开交付内容；真实数据失败不得静默替换为演示数据。
- 工作台不属于产品交付内容。排查报表或同步失败先区分读取和采集阶段；清库、修改同步设置不作为默认恢复动作。
