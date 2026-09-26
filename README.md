# Meterleaf

AI 用量账本，账户额度、Token 消耗、费用估算与多维统计。

Meterleaf 可以只读采集一个 Sub2API PostgreSQL 实例，也可以接收本机采集器推送的 Claude Code 本地直连用量，两种来源可单独或同时使用，用量保存到本地 SQLite 并生成独立报表。不代理模型请求、不修改 Sub2API，也不直接请求 OpenAI 或 Anthropic；单个容器即可运行。

## 能做什么

- **用量总览**：默认看历史至今的 Tokens、费用、请求和缓存命中率，可切到今天、近 7 天等范围；下方是同一范围的消耗趋势和模型分布。
- **账户额度**：总览中按当前周期显示 5 小时与 7 天窗口、重置时间及七天额度预估，并可直接排序、重命名和归档账户。
- **统计报表**：顶部是所选范围的摘要与环比，按小时、天、周、模型或账户汇总 Tokens、缓存命中率、请求数和费用，附合计行。
- **请求明细**：查看模型、来源、推理强度、Token 拆分与计价依据。
- **Claude Code 本地用量**：不经过网关的 Claude Code 由 Mac 上的本机采集器推送用量、套餐和 5 小时、7 天及 Fable 周额度，与网关用量在同一账本中统计。
- **独立估值**：同时保留订阅 Credits 与 USD，美元可切换订阅等价和标准 API 口径。

支持自定义日期、页面筛选、明暗主题和移动端；同步在后台进行，已有报表继续可读。

## 界面预览

### Web

![Web 用量总览：历史至今摘要、缓存命中率与账户额度](docs/images/web-overview.png)

<details>
<summary>统计报表</summary>

![Web 统计报表：模型分布与分组汇总](docs/images/web-reports.png)

</details>

<details>
<summary>请求明细</summary>

![Web 请求明细：模型、推理强度与用量](docs/images/web-requests.png)

</details>

### 移动端

| 用量总览                                                                       | 统计报表                                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| <img src="docs/images/mobile-overview.png" alt="移动端用量总览" width="300" /> | <img src="docs/images/mobile-reports.png" alt="移动端统计报表" width="300" /> |

<details>
<summary>请求明细</summary>

<img src="docs/images/mobile-requests.png" alt="移动端请求明细" width="300" />

</details>

## 快速开始

Meterleaf 有两种数据来源，至少配置一种。

- **Sub2API 网关**：在 `.env` 填写 `SUB2API_DATABASE_URL`。数据库账号只需读取 `public.accounts` 和 `public.usage_logs`，不需要写权限。
- **本地直连的 Claude Code**：在 `.env` 填写本机采集器生成的 `METERLEAF_INGEST_KEYS`，见下文[接入 Claude Code](#接入-claude-code)。只用 Claude Code 时把 `SUB2API_DATABASE_URL` 留空，并先生成写入密钥再启动服务。

在仓库目录中准备配置：

```sh
cp .env.example .env
```

按上面填写 `.env`，然后运行：

```sh
docker compose build
mkdir -p app_data
docker compose run --rm --no-deps --pull never --user root --entrypoint sh meterleaf -c 'chown bun:bun /app/app_data'
docker compose up -d --pull never
```

访问 `http://127.0.0.1:4318`。连接了 Sub2API 时，从右上角「数据同步」启动首次采集，默认不自动采集，可自行开启自动同步。只用 Claude Code 时没有这个入口，采集器推送后数据自动出现。

已发布镜像的拉取方式、跨主机访问、反向代理、配置项及备份恢复见[部署指南](docs/deployment.md)。应用不内置认证，可在反向代理层接入 OAuth/OIDC 认证。

### 接入 Claude Code

本地直连的 Claude Code 需要在使用它的 Mac 上安装本机采集器。采集器暂不提供下载，需要在 Mac 上构建，要求 Bun 与 Xcode 命令行工具：

```sh
bun install --frozen-lockfile
bun run build:collector
```

把 `dist/Meterleaf.app` 移到「应用程序」，然后生成写入密钥。`--server` 填这台 Mac 能访问到的 Meterleaf 地址，服务端不在本机时先按[部署指南](docs/deployment.md#接入本机采集器)开放访问：

```sh
/Applications/Meterleaf.app/Contents/MacOS/meterleaf-collector init --server https://meterleaf.example.com
```

命令会打印一行 `METERLEAF_INGEST_KEYS=来源标识:摘要`。把它加到服务端的 `.env`，再执行一次 `docker compose up -d --pull never` 让配置生效（`docker compose restart` 不会读取新配置）。之后在 Mac 上依次执行 `bind-history`、`sync` 和 `install-launchd`，每一步的含义见[本机采集器](docs/collector.md)。

## 文档

- [使用与报表](docs/reporting.md)：筛选、账户管理、同步显示及统计口径。
- [部署指南](docs/deployment.md)：安装、环境变量、升级、备份和排障。
- [计价说明](docs/pricing.md)：USD 分支、费率版本与自定义 JSON。
- [本机采集器](docs/collector.md)：接入本地直连的 Claude Code 用量、账户与额度。
- [贡献指南](AGENTS.md)：目录结构、代码规范、测试与提交要求。
- [版本与发布](docs/releasing.md)：版本递增、双架构镜像及 Release 流程。

本地演示无需上游凭据，需要 Bun 1.4.2 或更新版本：

```sh
bun install --frozen-lockfile
bun run dev:demo
```

## 许可证

[Apache-2.0](LICENSE)。第三方组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
