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

   系统每分钟以低优先级运行一次同步，「系统设置 → 通用 → 登录项与扩展」中会显示 Meterleaf。Claude Code 会删除较早的会话记录，后台任务需要保持运行，才能在删除前把用量记入账本。

## 日常查看与排障

`meterleaf-collector status` 显示同步进度、待发送数量、最近一次成功或失败的原因，以及账户归属情况，不会显示密钥。

- **网络不通或 Meterleaf 暂停**：未送达的数据保存在本机，恢复后自动补发，不会重复计数。
- **提示密钥无效**：确认 Meterleaf 的 `METERLEAF_INGEST_KEYS` 包含 `init` 输出的那一行并已重启。换电脑或重新生成密钥时，用 `init --force` 并替换服务端对应的行。
- **额度显示为过时**：Claude Code 并不在每次请求后刷新本地额度缓存，观察到的刷新发生在打开设置中的用量面板时。采集器不会主动请求额度，打开用量面板后，下一次同步会带上新快照。
- **切换过登录账户**：切换前后正在进行的请求可能无法确定属于哪个账户，会保留在「未归属」下，不会被算到当前账户。

停用时执行 `meterleaf-collector uninstall-launchd`。采集器的数据目录位于 `~/Library/Application Support/Meterleaf Collector`，其中保存写入密钥、读取进度和账户归属记录。不要删除它，否则归属记录丢失后，重新读取的历史会改记到「未归属」。
