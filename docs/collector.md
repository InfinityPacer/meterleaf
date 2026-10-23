# 本机采集器

[返回首页](../README.md)

本地直连的 Claude Code 不经过网关，它的用量只保存在使用它的电脑上。本机采集器在这台电脑上读取 Claude Code 的本地记录，把用量、账户和额度快照推送到 Meterleaf。Meterleaf 可以部署在 NAS 或另一台主机上，与这台电脑分开。没有 Sub2API 网关时，Meterleaf 也可以只接收采集器的数据。

## 它读什么、不碰什么

采集器只读取下面三处，不写入任何一处。

- `~/.claude/projects` 下的会话记录，从中读取每次请求的模型与 Token 用量，以及会话里 `/login` 成功的时间。
- `~/.claude.json`，从中读取登录账户的 UUID、组织类型、席位档位，以及 Claude Code 缓存的最近一次额度数据，包括 5 小时、7 天和 Fable 独立周额度。
- 当前登录账户的套餐字段。新版 Claude Code 只把订阅类型和速率档位保存在登录凭据里，macOS 上是钥匙串中的「Claude Code-credentials」，其他系统是 Claude 配置目录下的 `.credentials.json`。采集器用系统自带的 `security` 命令或直接读文件取出整条凭据，只保留这两个字段，访问令牌和刷新令牌不解析、不保存、不记录、不上传。
- 如果登记了额外 Claude 账户，还会读取每个目录下的 `.claude.json` 和该目录对应的登录凭据，读取方式与默认账户相同，见[多个 Claude 账户](#多个-claude-账户)。

它不会在 Claude Code 的目录里写入、改名、加锁或改权限，不改设置、hooks 或状态栏，不运行 Claude Code 命令，也不调用任何 Anthropic 接口，读取凭据不会产生网络请求。上传内容只有计量数字、模型、时间、账户标识和套餐，不包含对话、工具输出、文件路径、工作目录、邮箱、显示名或令牌。

凭据不会每次运行都读。采集器每次运行只看凭据的修改时间，这一步只取钥匙串条目的属性或文件状态，不读令牌。只有凭据被改写过（登录、刷新令牌或套餐变化时 Claude Code 都会改写）、刚登录或切换了账户、`~/.claude.json` 里的账户资料有变化，或者上一次读到的套餐还在等确认时，才读取凭据内容。凭据没有改写，其中的套餐就不会变，所以其余时候沿用已确认的套餐。读不到凭据时，例如钥匙串拒绝访问，等凭据下次改写再试。

凭据只代表当前登录的账户，而 Claude Code 切换账户时会先换凭据、后改 `~/.claude.json`。所以采集器只采用连续两次运行都对同一账户读到的同一套餐，新登录的账户要过一分钟左右才显示凭据里的套餐，切换途中读到的结果不会记到旧账户上。`scan` 只运行一次，会显示从凭据换算出的套餐并注明同步时确认后采用。读不到凭据时，例如钥匙串拒绝访问，采集器沿用此前为该账户记录的套餐；从没读到过时只能从席位档位识别 Team，其余显示为订阅账户，可以在 Meterleaf 中手动设置套餐，见[使用与报表](reporting.md#账户管理)。

## 统计口径

Claude Code 会把一次请求按内容块拆成多行保存，每行带着同一份用量。采集器按请求 ID 与消息 ID 合并这些行，每次请求只计一次。Claude Code 自带的 `/stats` 把每行都算了一遍，所以显示的 Token 总数约为实际的两倍，与 Meterleaf 不一致是预期现象。

费用由 Meterleaf 按[计价说明](pricing.md)中的价格表估算，1 小时与 5 分钟缓存写入分开计价。它是按公开价格计算的估值，不是 Claude 订阅账单。

## 其他供应商的模型

Claude Code 也可以通过兼容接口使用别家的模型，例如经 OpenCode Go 使用 DeepSeek。这些请求的会话记录和 Claude 订阅写在同一个目录，记录里没有账户，也没有请求发往的地址，采集器只能靠模型名区分。

所以采集器只把 `claude-` 开头的模型按登录时间归到 Claude 账户。其他模型默认归到一个叫「其他模型」的账户，不会算进 Claude 订阅的用量。想让它们显示成独立的供应商账户，在采集器数据目录的 `config.json`（macOS 上是 `~/Library/Application Support/Meterleaf Collector/config.json`）里加一项 `modelAccounts`：

```json
{
  "modelAccounts": [
    {
      "match": "deepseek-*",
      "id": "opencode-go",
      "name": "OpenCode Go",
      "platform": "opencode-go",
      "kind": "subscription",
      "plan": "go"
    }
  ]
}
```

- `match` 是模型名，`*` 匹配任意字符。规则按顺序取第一条命中的，所以也能把某个 `claude-` 模型单独分出去。
- `id` 是账户在这台电脑来源里的标识，只能用字母、数字、`-` 和 `_`。改 `name` 只改显示名；改 `id` 会把历史用量整体移到新账户。
- `kind` 可填 `subscription`、`api` 或 `unknown`，省略时为 `unknown`。`plan` 可选，省略时不显示套餐；`platform` 为 `opencode-go` 时填 `go` 或 `go-plus`，页面显示为 Go 或 Go Plus。

保存后下一次同步生效，不需要重启后台任务。映射有变化时，采集器会把已经推送过的用量按新映射重新归属并补推一次，服务端的报表随之更新。`meterleaf-collector status` 会列出当前的映射。

想在 Meterleaf 里看到 OpenCode Go 的额度，需要在服务端单独配置 Go 的 Key，见[部署指南](deployment.md#opencode-go-额度可选)。采集器本身不读取 Go 的 Key，也不调用任何供应商接口。

## 多个 Claude 账户

一台 Mac 上可以用多个 Claude 订阅账户。默认账户使用 `~/.claude`，其他账户分别设 `CLAUDE_CONFIG_DIR` 登录，例如 `~/.claude-profiles/work`。如果把这些目录的 `projects` 软链接到 `~/.claude/projects`，会话记录集中在一处，方便跨账户恢复，但 JSONL 的每一行都没有账户字段。采集器只能按登录时间线归属，而时间线只代表默认目录当前登录的账户，额外账户的用量会被记到默认账户。

Claude Code 的 OpenTelemetry 日志能补上这个信息。开启导出后，每次 API 请求都会发出一条 `claude_code.api_request` 日志，带 `user.account_uuid`、`organization.id`、`session.id` 和 `request_id`。`request_id` 与会话记录里的 `requestId` 相同，服务端据此把那次请求归到正确的账户。

Token 用量仍由采集器读取会话记录，因为 OTEL 没有 1 小时与 5 分钟缓存写入的拆分、推理 Tokens 和 web search 次数等计价需要的字段。OTEL 只回答这次请求属于哪个账户。归属优先级从高到低是采集器的模型映射、OTEL 给出的请求账户、登录时间线。模型映射是用户明确指定的，服务端不会覆盖。

### 登记额外账户

先为每个额外账户登记配置目录，可以同时指定该账户的状态栏额度缓存。

```sh
meterleaf-collector claude-profiles \
  "$HOME/.claude-profiles/work" \
  "$HOME/.claude-profiles/personal=$HOME/.cache/claude-statusline/personal.tsv"
```

每个参数是 `CLAUDE_CONFIG_DIR` 的绝对路径，可用 `=` 接该账户的状态栏额度缓存。最多 20 个，目录不能是默认 Claude 目录。保存后下一轮同步生效，`meterleaf-collector status` 会列出已登记的目录与最近一次结果，执行 `meterleaf-collector claude-profiles off` 清除。

采集器从每个目录的 `.claude.json` 读取账户与额度，从该目录对应的登录凭据读取订阅类型，再把账户资料推送到 Meterleaf。额外账户不进入默认账户的登录时间线，因此不会改变已有会话的归属；目录读不到或未登录时只跳过该项，不影响默认账户和其他目录。状态栏额度缓存按读取前后两次看到的同一账户归属，前后不一致时跳过并在 `status` 中说明。

额外账户的 `projects` 通常是指回 `~/.claude/projects` 的软链接，采集器仍然只扫描默认目录。会话被拆到独立的 `projects` 目录时，这部分会话目前不会被采集。

### 开启 OTEL 导出

推荐让 Claude Code 把日志发给这台电脑上的采集器中转。`install-launchd` 会同时启动一个只监听 `127.0.0.1:4319` 的常驻进程，它把日志写进采集器的本机待发送队列，每分钟的同步再把这些记录和用量一起推送到 Meterleaf。服务端或网络暂时不可用时记录留在本机，恢复后自动补发。队列最多保留最近 5 万条，长期连不上时更早的记录会被丢弃，这些请求退回按登录时间线归属，日志里会有提示。

在 `~/.claude/settings.json` 中加上下面的设置。不需要 `otelHeadersHelper`，中转只接受本机回环地址上的请求，也不再单独传递写入密钥。

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://127.0.0.1:4319/v1/logs"
  }
}
```

修改设置后重新打开 Claude Code 会话才会生效。`meterleaf-collector status` 的待发送一行会列出 `OTEL` 数量，可以确认记录已经进入队列。后台任务未安装时，也可以手动运行 `meterleaf-collector otel-relay` 启动同一个入口。

端口与其他 OTLP 工具冲突时，在采集器 `config.json` 里加入 `"otelRelay": { "port": 4320 }`，端口范围是 1024 到 65535。保存后重新执行一次 `meterleaf-collector install-launchd`，让后台任务按新端口重启；同时把 `settings.json` 里的地址改成同一个端口。

希望 Claude Code 直接连服务端时，旧配置仍然可用。把地址换成这台电脑访问 Meterleaf 的地址，并保留 `otelHeadersHelper`。

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "none",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "https://meterleaf.example.com/api/otel/v1/logs"
  },
  "otelHeadersHelper": "/Applications/Meterleaf.app/Contents/MacOS/meterleaf-collector otel-headers"
}
```

`meterleaf-collector otel-headers` 从采集器配置读取写入密钥，向标准输出打印一行 `{"Authorization":"Bearer ..."}`，不输出其他内容。没有初始化时命令报错并以非 0 退出，Claude Code 的日志导出会失败，但用量仍由采集器正常推送，不受影响。直连方式要求服务端先升级到支持该入口的版本，见[部署指南](deployment.md#让采集器访问服务)。

这些日志只发到你自己的 Meterleaf，不发给 Anthropic。Claude Code 默认不导出提示词与回复；采集器的本机中转与 Meterleaf 服务端都只保留请求 ID、账户 UUID、组织 UUID、会话 ID、模型和请求时间，其余属性即使到达也不落库，也不写进日志。

服务端比采集器先升级时，旧采集器推送的用量还没有 `attribution` 字段。如果配置过 `modelAccounts`，这段时间里 OTEL 会暂时覆盖模型映射的归属；采集器升级后会重发全部已推送用量，归属随之恢复。所以用过模型映射时，请在升级服务端后尽快升级采集器。

## 安装

采集器需要 macOS 13 或更新版本，目前不提供下载，需要在这台 Mac 上从仓库构建。构建需要 Bun 1.4.2 或更新版本，以及 Xcode 命令行工具（没有时执行 `xcode-select --install`）。

```sh
bun install --frozen-lockfile
bun run build:collector
```

构建产物是 `dist/Meterleaf.app`，把它移到「应用程序」文件夹。以下命令中的 `meterleaf-collector` 指应用内的可执行文件。

```sh
alias meterleaf-collector="/Applications/Meterleaf.app/Contents/MacOS/meterleaf-collector"
```

## 首次接入

1. 生成写入密钥。`--server` 填这台电脑访问 Meterleaf 的地址。

   ```sh
   meterleaf-collector init --server https://meterleaf.example.com
   ```

   命令会打印一行 `METERLEAF_INGEST_KEYS=来源标识:摘要`。把它加到 Meterleaf 服务端的 `.env`，多台电脑用英文逗号连接，再执行一次 `docker compose up -d` 让配置生效，细节见[部署指南](deployment.md#写入密钥)。完整密钥只保存在本机配置文件中，不需要也不应转交。

   服务端在 NAS 等其他主机时，这台电脑需要能访问它，局域网访问与公网推送的设置见[部署指南](deployment.md#让采集器访问服务)。

2. 声明历史归属。会话记录里没有账户信息，采集器靠每次运行时观察到的登录账户来归属用量。首次运行前的历史无法自动判断，如果这台电脑一直只登录过当前账户，在首次同步前执行下面的命令。

   ```sh
   meterleaf-collector bind-history
   ```

   不执行时，这部分历史会记在「未归属」账户下，之后执行也会重新归属并在下次同步时更新。

3. 先在本地核对，再推送一次。

   ```sh
   meterleaf-collector scan
   meterleaf-collector sync
   ```

   `scan` 只在本地汇总，不联网，可用来与其他统计工具对照。`sync` 成功后，Meterleaf 总览的账户区会出现名为「Claude Code」的账户，套餐显示在徽标中。可以在账户菜单里改成更容易辨认的名称，见[使用与报表](reporting.md#账户管理)。

4. 安装后台任务。

   ```sh
   meterleaf-collector install-launchd
   ```

   系统每分钟以低优先级运行一次同步，同时常驻运行接收 Claude Code OTEL 日志的本机中转。「系统设置 → 通用 → 登录项与扩展」中会显示带图标的 Meterleaf.app。如果命令提示等待批准，在那里打开 Meterleaf 的开关即可。那里会标注「来自身份不明的开发者」，因为构建使用的是本机临时签名，不影响运行。

   Claude Code 会删除较早的会话记录，后台任务需要保持运行，才能在删除前把用量记入账本。后台任务的输出写在数据目录的 `logs` 下，同步和 OTEL 中转共用这些文件。每个文件超过 1 MB 时改名为 `.1` 并重新开始，只保留这一份旧文件，日志总共不超过约 4 MB。

   后台任务随 Meterleaf.app 注册，应用需要留在原位置。如果设置了 `METERLEAF_COLLECTOR_HOME`、`CLAUDE_CONFIG_DIR`、`METERLEAF_CLAUDE_JSON` 或 `--claude-json`，这些路径只能通过环境变量传给后台任务，命令会改为在 `~/Library/LaunchAgents` 安装普通的后台任务，登录项中显示为可执行文件名。

## 升级

先升级 Meterleaf 服务端，再升级采集器。新版采集器可能推送旧服务端不认识的额度类型（例如 Fable 周额度），旧服务端会拒收整批数据；数据留在采集器的待发送队列里，服务端升级后自动补推，不会丢失。

重新构建后，用新的 `dist/Meterleaf.app` 替换「应用程序」中的旧版本，再执行一次 `meterleaf-collector install-launchd`。这条命令会按新应用包重新登记同步和 OTEL 中继两个后台任务。读取进度、账户归属和写入密钥都在数据目录中，替换应用不会丢失。

如果 `status` 显示后台任务已启用，但「最近成功」的时间几分钟都不更新，把问题和 `launchctl print gui/$(id -u)/io.meterleaf.collector.background` 的输出反馈给维护者。

## 状态栏额度缓存（可选）

`~/.claude.json` 里的额度缓存只在打开用量面板时刷新，平时很快过期。更新的额度只在 Claude Code 运行时出现：在终端里交给状态栏命令，在无界面模式下写进输出流。采集器不运行 Claude Code，也不调用额度接口，所以它只约定一个额度文件，由你按自己使用 Claude Code 的方式写出这个文件。仓库提供两种写法：终端用户用状态栏脚本，通过 Paseo 使用的见[下一节](#通过-paseo-使用-claude-code)。其他工具可以照文件格式自己实现，只要数据来自 Claude Code 本身给出的额度，不要用登录令牌另行请求额度接口。

Claude Code 每一轮都会把最新的 5 小时与 7 天额度传给状态栏命令。如果你的状态栏脚本把它写成文件，采集器可以读取这个文件，额度会比 `~/.claude.json` 里的缓存新得多。

没有现成状态栏脚本时，可使用仓库中的 `scripts/claude-statusline.sh`（需要 Bash 与 `jq`）。在 Claude Code 的 `~/.claude/settings.json` 中添加下面一项，将路径改为脚本的实际绝对路径；如果已配置状态栏，请把额度缓存逻辑整合进现有脚本，不要覆盖原命令：

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /absolute/path/to/meterleaf/scripts/claude-statusline.sh"
  }
}
```

脚本在终端显示简短的 5h / 7d 百分比，只把额度和真实重置时间保存到采集器自己的目录，不存储完整状态栏内容，不读凭据、不发网络请求。macOS 上启用默认缓存路径：

```sh
meterleaf-collector statusline-cache "$HOME/Library/Application Support/Meterleaf Collector/statusline-quota.tsv"
```

Claude Code 下一轮提供额度后，等待每分钟同步，Meterleaf 的账户卡片就会显示重置时间（跨天时附日期）。没有提供额度时保留未知，不从首次请求时间推算。非 macOS 或自定义采集器目录时，给状态栏命令设置 `METERLEAF_STATUSLINE_CACHE`，并让采集器读取同一个路径。

文件每行一个窗口，三列用制表符分隔，依次是窗口名 `five_hour` 或 `seven_day`、已用百分比、重置时间的 Unix 秒。例如 `five_hour	18	1790277600`。启用时提供绝对路径：

```sh
meterleaf-collector statusline-cache ~/.cache/claude-statusline/rate-limits.tsv
```

采集器同样只读这个文件。文件里没有账户和采样时间，采集器把文件修改时间当作采样时间，并按那一刻观察到的登录账户归属；切换账户前后无法判断时跳过这次采样。Meterleaf 对同一账户和窗口使用采样时间最新的一份，两个来源不会相加。格式不对或窗口名不认识的行会被跳过，其余行照常使用，跳过时采集日志会记一行说明。停用时执行 `meterleaf-collector statusline-cache off`。

## 通过 Paseo 使用 Claude Code

Paseo 以无界面模式启动 Claude Code，状态栏命令不会执行，额度缓存因此停在最后一次在终端使用的时候，页面上的 5 小时窗口长期显示「等待更新」。无界面模式下，Claude Code 每次请求后会在输出流里给出同样的 5 小时与 7 天额度，Paseo 收到后并不保存。仓库里的 `scripts/paseo-claude-quota.sh` 包在 Claude Code 外面，参数和输入原样交给它，Paseo 收到的输出不变，脚本只把其中的额度写进上一节的额度文件。

先把脚本复制到不随仓库分支变化的位置，Paseo 每次启动 Claude 代理都要用到它，文件不在时代理无法启动。

```sh
install -m 755 scripts/paseo-claude-quota.sh ~/.local/bin/meterleaf-paseo-claude
```

再在 `~/.paseo/config.json` 中把 Claude 的启动命令换成它（需要 `jq`），执行 `paseo reload`。之后新启动的 Claude 代理生效，已在运行的代理要重新开始才会经过脚本。

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": [
          "/absolute/path/to/meterleaf/scripts/paseo-claude-quota.sh"
        ],
        "env": {
          "METERLEAF_STATUSLINE_CACHE": "/Users/you/.cache/claude-statusline/rate-limits.tsv"
        }
      }
    }
  }
}
```

- `METERLEAF_STATUSLINE_CACHE` 填 `meterleaf-collector statusline-cache` 配置的同一个路径，省略时用采集器数据目录里的默认文件。终端里的状态栏脚本可以同时写这个文件，采集器取修改时间最新的一份。
- Claude Code 不在 `~/.local/bin/claude` 时，用 `METERLEAF_CLAUDE_BIN` 指定实际位置。
- 设置了 `ANTHROPIC_BASE_URL`、Bedrock 或 Vertex 的代理（例如经 OpenCode Go 使用其他模型）不属于 Claude 订阅，脚本直接运行 Claude Code，不写额度。
- 输出流里没有 Fable 周额度，Fable 仍然只来自 `~/.claude.json` 的缓存。

脚本不读取登录凭据，也不发出额外请求。Paseo 自带的用量面板会用 Claude Code 的登录令牌请求 Anthropic 的额度接口，不要把那份结果转给采集器。

## 日常查看与排障

`meterleaf-collector status` 显示同步进度、待发送数量、最近一次成功或失败的原因，以及账户归属情况，不会显示密钥。

- **网络不通或 Meterleaf 暂停**：未送达的数据保存在本机，恢复后自动补发，不会重复计数。OTEL 请求归属也走同一个队列，等待期间 `status` 的 `OTEL` 数量会逐渐增加。
- **账户归属没有按 OTEL 更新**：先看 `status` 里 OTEL 中继是否显示「已启用」，再确认 `status` 的 `OTEL` 数量在请求后增加。数量长期不变时，检查 `settings.json` 的地址端口与采集器 `config.json` 的 `otelRelay.port` 是否一致，以及该端口是否被其他程序占用。中继只记接收条数，日志在数据目录的 `logs` 下。
- **更换服务地址**：比如从局域网地址改为公网 HTTPS 地址，执行 `meterleaf-collector server https://meterleaf.example.com`。写入密钥不变，服务端不用改。
- **提示密钥无效**：确认 Meterleaf 的 `METERLEAF_INGEST_KEYS` 包含 `init` 输出的那一行并已重启。换电脑或重新生成密钥时，用 `init --force` 并替换服务端对应的行。
- **额度显示为过时**：Claude Code 并不在每次请求后刷新 `~/.claude.json` 里的额度缓存，观察到的刷新发生在打开设置中的用量面板时。采集器不会主动请求额度，可以启用上面的状态栏额度缓存获得更新的数据。
- **Fable 显示「等待更新」**：状态栏只拿得到 5 小时与 7 天额度，Fable 周额度只来自 `~/.claude.json` 的缓存。上一周期结束后，在 Claude Code 里打开一次用量面板，下一轮采集就会带上新周期的 Fable 额度。
- **切换过登录账户**：用量按登录账户分开记。两次运行之间切换账户时，采集器按切换时刻把这段时间的用量分给前后两个账户。在会话里执行 `/login` 时，以会话记录里登录成功的时间为准；在会话外登录时，以登录凭据的修改时间为准；两者都没有时，这段时间整体算给新账户。切换后其他终端里仍在运行的会话，可能还有几十秒继续使用旧账户，这几十秒的用量会算给新账户。额度读数不做这种推断，切换前后无法判断属于哪个账户的读数直接跳过。

停用时执行 `meterleaf-collector uninstall-launchd`。采集器的数据目录位于 `~/Library/Application Support/Meterleaf Collector`，其中保存写入密钥、读取进度和账户归属记录。不要删除它，否则归属记录丢失后，重新读取的历史会改记到「未归属」。
