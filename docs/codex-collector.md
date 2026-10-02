# 接入 Codex 本地用量

[返回部署指南](deployment.md)

Codex 本地采集器只读扫描 `$CODEX_HOME/sessions` 和 `$CODEX_HOME/archived_sessions` 下的 JSONL 记录，未设置 `CODEX_HOME` 时使用 `~/.codex`。它读取模型、时间戳和每次请求的 Token 用量，通过独立写入密钥推送到 Meterleaf，不需要请求经过网关。

它不读取 `auth.json`，不改 Codex 的配置、会话文件、登录状态或请求路径，也不调用 OpenAI API。上传内容仅含模型、时间、计量数字和不可逆摘要；对话、工具输出、项目路径、会话原始 ID 和凭据不会上传。

本地 CC、Codex 和网关是独立来源，**不做跨来源去重**。同一请求同时被网关和本机记录时，合并总览可能重复，应按来源或账户分别查看。定时任务重复读取同一份 Codex 记录、会话转入归档或网络重试不会重复入账。

## 安装与连接

从仓库构建，需要 Bun 1.4.2 或更新版本：

```sh
bun install --frozen-lockfile
bun run build:codex-collector
mkdir -p ~/.local/bin
cp dist/meterleaf-codex-collector ~/.local/bin/
~/.local/bin/meterleaf-codex-collector init --server https://meterleaf.example.com --source-id codex-local
```

`--server` 填本机可访问的 Meterleaf 地址。命令打印 `METERLEAF_INGEST_KEYS=codex-local:摘要`，把这一对来源和摘要追加到服务端配置，已有 CC 或其他来源时用英文逗号连接，不要覆盖旧值。然后重建 Meterleaf 容器使配置生效，详见[写入密钥](deployment.md#写入密钥)。完整密钥仅保存在本机配置目录。

每台电脑使用不同的来源名称，已有账本不要更换来源名。`init` 不会覆盖已有配置；更改服务地址可以编辑采集器自己的 `config.json`，不要更改密钥和来源名称。

macOS 上安装后台任务：

```sh
~/.local/bin/meterleaf-codex-collector install-launchd
~/.local/bin/meterleaf-codex-collector status
```

采集器每分钟低优先级运行一次，单轮读取上限为 64 MiB，优先补采最近修改的会话。未完成的历史在后续轮次继续；没有变化的文件不会重读正文。首次历史较多时可能需要数小时，期间可以继续正常使用 Codex。进程结束后不占常驻内存。

此后台任务与 CC 采集器使用不同名称和数据目录，可以同时启用。不安装后台任务时，也可以直接执行 `meterleaf-codex-collector sync` 同步一轮。

## 统计口径

- 使用每次请求的用量，不把累计计数反复相加；重复的额度通知不作为新请求。切换模型以对应的会话上下文为准，不用当前全局配置替历史补模型。
- 缓存读取从输入中扣除，推理量保留为输出的子集；新记录中的缓存写入单独保存。旧记录缺失的字段保持未知，不猜测缓存写入 TTL。
- 记录没有可靠的历史登录账号、套餐或余额归属，因此显示统一的「Codex 本机」账户，不自动绑定当前账号，也不展示推测额度。账户可以在 Meterleaf 中改名。
- 没有保存用量的请求、已经删除的历史，以及缺少模型或计量异常的记录无法凭空恢复。模型不在 Meterleaf 价格表中时可保留用量，但费用可能未计价。
- 本地 JSONL 是 Codex 的内部持久化格式，并非稳定计量 API；升级 Codex 后应留意采集日志的异常计数。

## 状态、日志与停用

默认数据目录是 `~/Library/Application Support/Meterleaf Codex Collector`，可通过 `METERLEAF_CODEX_HOME` 更改，但不能放进 Codex 目录。后台任务安装时记录当前的两个目录设置，修改路径后需要重新执行 `install-launchd`。

`status` 显示已跟踪文件、事件数、待发送数及最近成功时间。日志在数据目录的 `logs/sync.log`，达到 1 MiB 后保留一份旧日志：

- `deferred: true` 表示本轮达到读取上限，后台会继续补采。
- `invalid` 表示本轮遇到格式或计量异常，其他记录继续处理；`unreadable` 表示存在不可读取的文件。
- 网络或服务端失败时保留待发送记录，下次自动重试，不影响 Codex 使用。

停止后台任务：

```sh
~/.local/bin/meterleaf-codex-collector uninstall-launchd
```

停用不会删除采集器或 Codex 的数据。备份时保留采集器完整数据目录，包括配置、SQLite 主文件及运行时可能存在的 WAL 文件；最好先停止后台任务。恢复服务端账本时，应同时恢复相应时间点的采集器进度，或在保存旧采集器状态后重新补采仍然存在的本地记录。
