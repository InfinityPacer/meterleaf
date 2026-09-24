# 本机采集器

[返回首页](../README.md)

本地直连的 Claude Code 不经过网关，它的用量只保存在使用它的电脑上。本机采集器在这台电脑上读取 Claude Code 的本地记录，把用量、账户和额度快照推送到 Meterleaf。Meterleaf 可以部署在 NAS 或另一台主机上，与这台电脑分开。

## 它读什么、不碰什么

采集器只以只读方式打开两处文件。

- `~/.claude/projects` 下的会话记录，从中读取每次请求的模型与 Token 用量。
- `~/.claude.json`，从中读取登录账户的 UUID、组织类型、套餐档位，以及 Claude Code 缓存的最近一次额度数据。

它不会在 Claude Code 的目录里写入、改名、加锁或改权限，不改设置、hooks 或状态栏，不读取 OAuth 令牌、钥匙串或凭据文件，也不调用任何 Anthropic 接口。上传内容只有计量数字、模型、时间和账户标识，不包含对话、工具输出、文件路径、工作目录、邮箱或显示名。

## 统计口径

Claude Code 会把一次请求按内容块拆成多行保存，每行带着同一份用量。采集器按请求 ID 与消息 ID 合并这些行，每次请求只计一次。Claude Code 自带的 `/stats` 把每行都算了一遍，所以显示的 Token 总数约为实际的两倍，与 Meterleaf 不一致是预期现象。

费用由 Meterleaf 按[计价说明](pricing.md)中的价格表估算，1 小时与 5 分钟缓存写入分开计价。它是按公开价格计算的估值，不是 Claude 订阅账单。

## 安装

采集器需要 macOS，在仓库中构建。

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

   命令会打印一行 `METERLEAF_INGEST_KEYS=来源标识:摘要`。按[部署指南](deployment.md#接入本机采集器)把它加到 Meterleaf 的环境变量并重启服务。完整密钥只保存在本机配置文件中，不需要也不应转交。

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

   `scan` 只在本地汇总，不联网，可用来与其他统计工具对照。`sync` 成功后，Meterleaf 的账户页会出现对应的 Claude 账户。

4. 安装后台任务。

   ```sh
   meterleaf-collector install-launchd
   ```

   系统每分钟以低优先级运行一次同步，「系统设置 → 通用 → 登录项与扩展」中会显示带图标的 Meterleaf.app。如果命令提示等待批准，在那里打开 Meterleaf 的开关即可。那里会标注「来自身份不明的开发者」，因为构建使用的是本机临时签名，不影响运行。

   Claude Code 会删除较早的会话记录，后台任务需要保持运行，才能在删除前把用量记入账本。后台任务的输出写在数据目录的 `logs` 下。

   后台任务随 Meterleaf.app 注册，应用需要留在原位置。如果设置了 `METERLEAF_COLLECTOR_HOME`、`CLAUDE_CONFIG_DIR`、`METERLEAF_CLAUDE_JSON` 或 `--claude-json`，这些路径只能通过环境变量传给后台任务，命令会改为在 `~/Library/LaunchAgents` 安装普通的后台任务，登录项中显示为可执行文件名。

## 升级

重新构建后，用新的 `dist/Meterleaf.app` 替换「应用程序」中的旧版本，再执行一次 `meterleaf-collector install-launchd`。读取进度、账户归属和写入密钥都在数据目录中，替换应用不会丢失。

如果 `status` 显示后台任务已启用，但「最近成功」的时间几分钟都不更新，把问题和 `launchctl print gui/$(id -u)/io.meterleaf.collector.background` 的输出反馈给维护者。

## 状态栏额度缓存（可选）

Claude Code 每一轮都会把最新的 5 小时与 7 天额度传给状态栏命令。如果你的状态栏脚本把它写成文件，采集器可以读取这个文件，额度会比 `~/.claude.json` 里的缓存新得多。

文件每行一个窗口，三列用制表符分隔，依次是窗口名 `five_hour` 或 `seven_day`、已用百分比、重置时间的 Unix 秒。例如 `five_hour	18	1790277600`。启用时提供绝对路径：

```sh
meterleaf-collector statusline-cache ~/.cache/claude-statusline/rate-limits.tsv
```

采集器同样只读这个文件。文件里没有账户和采样时间，采集器把文件修改时间当作采样时间，并按那一刻观察到的登录账户归属；切换账户前后无法判断时跳过这次采样。Meterleaf 对同一账户和窗口使用采样时间最新的一份，两个来源不会相加。停用时执行 `meterleaf-collector statusline-cache off`。

## 日常查看与排障

`meterleaf-collector status` 显示同步进度、待发送数量、最近一次成功或失败的原因，以及账户归属情况，不会显示密钥。

- **网络不通或 Meterleaf 暂停**：未送达的数据保存在本机，恢复后自动补发，不会重复计数。
- **更换服务地址**：比如从局域网地址改为公网 HTTPS 地址，执行 `meterleaf-collector server https://meterleaf.example.com`。写入密钥不变，服务端不用改。
- **提示密钥无效**：确认 Meterleaf 的 `METERLEAF_INGEST_KEYS` 包含 `init` 输出的那一行并已重启。换电脑或重新生成密钥时，用 `init --force` 并替换服务端对应的行。
- **额度显示为过时**：Claude Code 并不在每次请求后刷新 `~/.claude.json` 里的额度缓存，观察到的刷新发生在打开设置中的用量面板时。采集器不会主动请求额度，可以启用下面的状态栏额度缓存获得更新的数据。
- **切换过登录账户**：切换前后正在进行的请求可能无法确定属于哪个账户，会保留在「未归属」下，不会被算到当前账户。

停用时执行 `meterleaf-collector uninstall-launchd`。采集器的数据目录位于 `~/Library/Application Support/Meterleaf Collector`，其中保存写入密钥、读取进度和账户归属记录。不要删除它，否则归属记录丢失后，重新读取的历史会改记到「未归属」。
