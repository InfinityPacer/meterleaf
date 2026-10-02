# 接入 CLIProxyAPI（CPA）

[返回部署指南](deployment.md)

CPA 同步器读取 **usage-report 插件已经保存的 SQLite 账本**，将经过 CPA 的 GPT/Codex 和 Claude 请求作为独立来源推送到 Meterleaf。它不代理请求、不调用模型、不修改 CPA 配置，也不消费 CPA 的用量队列。无需提供 CPA 管理密码或模型 API Key。

需要先在 CPA 中启用 [usage-report 插件](https://github.com/andyWang1688/cpa-usage)。已验证插件 v0.3.1 的 `usage_events` 表结构。同步器和 CPA 需要能访问同一份本地数据库目录；当前不支持直接连接没有该插件的 CPA，也不读取本机 Codex 会话。

## Docker 安装

在 Meterleaf 仓库目录准备独立密钥和同步进度目录（需要 Python 3.10 或更新版本）：

```sh
mkdir -p cpa_data
python3 - <<'PY'
import hashlib, os, secrets
os.umask(0o077)
key = 'mlk_' + secrets.token_urlsafe(32)
with open('cpa_ingest_key', 'x') as f:
    f.write(key)
print('cpa:' + hashlib.sha256(key.encode()).hexdigest())
PY
```

把打印的 `cpa:摘要` 添加到 `.env` 的 `METERLEAF_INGEST_KEYS`，已有 Mac 采集器密钥时用英文逗号追加，**不要覆盖原来的值**。密钥文件只供同步容器读取，不要提交或分享。

再设置 CPA 插件账本所在的宿主机目录，例如：

```dotenv
CPA_USAGE_DIRECTORY=/srv/cliproxyapi/auth
CPA_SOURCE_ID=cpa
CPA_MODEL_SCOPE=all
```

此目录中应有 `usage-report.sqlite`，运行时通常还有 `usage-report.sqlite-wal` 和 `usage-report.sqlite-shm`。必须只读挂载整个目录，不能只复制主文件，也不要对正在写入的账本使用 SQLite 的 immutable 模式。目录中可能同时存放 CPA 登录文件；同步器的代码只打开账本，不读取这些登录文件。

若改变 `CPA_SOURCE_ID`，密钥摘要前的来源名称必须一起修改。已有账本的来源名应保持不变，否则重新导入会形成另一份数据。

启动服务（同时重建 Meterleaf，让新增密钥生效）：

```sh
docker compose -f compose.yaml -f compose.cpa.yaml --profile cpa config -q
docker compose -f compose.yaml -f compose.cpa.yaml --profile cpa up -d --no-build
docker compose -f compose.yaml -f compose.cpa.yaml --profile cpa logs -f cpa-collector
```

同步器首次补采现有账本，追平后每分钟检查一次。账户名称显示为 `CPA · 匿名编号`，可在账户菜单改名。API Key、账户原始标识和请求正文不会推送到 Meterleaf。

## 统计范围与限制

- `CPA_MODEL_SCOPE=all` 接入账本内可识别的 GPT/Codex 和 Claude 模型；`gpt` 只接入 GPT/Codex。切换范围会重新扫描历史，已有记录按稳定标识去重。缩小范围不会删除已导入的数据。
- 本机 CC 和 CPA 是两个独立来源。同一 Claude 请求若在两处都留下记录，会分别保存，**跨来源没有自动去重**；合并总览可能重复。需要避免这种情况时，首次启动就使用 `gpt`，或按来源/账户筛选查看。
- GPT 输入中的缓存命中和缓存写入会从普通输入扣除；Claude 普通输入按其独立计量口径保留。推理 Tokens 是输出的子集，不额外加进总数。
- 此版本插件没有保存供应商、套餐、额度、服务档位、推理强度或缓存写入 TTL。同步器不会猜测这些信息；费用是 Meterleaf 价格表的估值，不代表订阅账单或 CPA 实际扣费。
- 不认识的模型或计量异常记录不猜算，保留匿名拒收标识并在日志的 `rejected_total` 中报告，其他记录继续同步。更正适配后会在每日重扫时重试；插件升级改变格式时应先核对兼容性。
- CPA 已清理、从未记录或在插件启用前发生的请求无法恢复。

## 数据保留与停用

账本保存在 Meterleaf 数据目录，同步进度保存在 `cpa_data`。只有服务端确认整批写入后才保存进度；失败自动重试，即使响应丢失也不会重复计数。数据库被替换、回滚或出现低序号补录时会重扫并去重。

备份时保留 Meterleaf 的完整数据目录、`cpa_data` 和 `cpa_ingest_key`。备份/恢复 Meterleaf 账本与同步进度应保持同一时间点；若仅恢复旧的 Meterleaf 账本，应在停止同步器后备份并移走 `cpa_data`，让源端仍保留的历史重新补采。

停止同步：

```sh
docker compose -f compose.yaml -f compose.cpa.yaml --profile cpa stop cpa-collector
```

停用不会删除 CPA 或 Meterleaf 的数据。排障先检查容器健康状态、只读目录权限和日志；`sync_failed` 表示该轮失败并等待重试，`rejected_total` 非零表示存在未能转换的记录。不要清空原始账本。

开发回归：

```sh
python3 -m unittest discover -s collectors/cpa -p 'test_*.py' -v
```
