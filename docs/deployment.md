# 部署指南

[返回首页](../README.md)

Meterleaf 单容器提供前端与 API，只读访问 Sub2API PostgreSQL，使用本地 SQLite 保存账本。不代理模型请求，不修改 Sub2API，也不直接请求 OpenAI。

## 安装

需要 Docker Compose，以及从容器内可访问的 Sub2API 数据库。数据库账号需对 `public.accounts` 和 `public.usage_logs` 有 SELECT 权限，不需要写权限。

```sh
cp .env.example .env
```

填写 `SUB2API_DATABASE_URL` 后先校验配置：

```sh
docker compose config -q
```

Compose 同时支持源码构建和已发布镜像，以下路径择一执行。先准备数据目录：

```sh
mkdir -p app_data
```

源码构建：

```sh
docker compose build
docker compose run --rm --no-deps --pull never --user root --entrypoint sh meterleaf -c 'chown bun:bun /app/app_data'
docker compose up -d --pull never
```

已发布镜像：随附 `compose.yaml` 的 `image` 默认指向 `infinitypacer/meterleaf:latest`，源码路径仍使用 `build: .`。需要固定版本时，将 `image` 改为例如 `infinitypacer/meterleaf:0.1.0` 或 `ghcr.io/infinitypacer/meterleaf:0.1.0`，再执行：

```sh
docker compose pull
docker compose run --rm --no-deps --pull never --user root --entrypoint sh meterleaf -c 'chown bun:bun /app/app_data'
docker compose up -d --no-build --pull never
```

完成后用 `docker compose ps` 检查状态，默认访问 `http://127.0.0.1:4318`。镜像以 Bun 用户运行，挂载目录必须可写；不要让多个 Meterleaf 进程共用同一账本。发布流程见[版本与发布](releasing.md)。

生产构建包含 PWA 清单、图标和离线页，浏览器可将应用安装为独立窗口，无需额外安装插件。除本机地址外，需要 HTTPS；反向代理须允许访问 `/manifest.webmanifest`、`/sw.js`、`/offline.html` 和 `/icons/*`。离线资源不缓存 API 或账户数据，断网后重新打开不会展示旧账本。

随附 Compose 仅绑定宿主机回环地址。如果反向代理在其他容器中，应加入共享 Docker 网络并访问 `meterleaf:4318`，或显式调整宿主机绑定地址。应用不内置认证，可在代理层接入 OAuth/OIDC 认证。

## 配置

完整模板见 [`.env.example`](../.env.example)。本地 Bun 启动读取 `.env`；Compose 仅传递 [compose.yaml](../compose.yaml) 中声明的变量，不会自动注入模板中的全部键。

| 变量                                   | 默认值         | 说明                                       |
| -------------------------------------- | -------------- | ------------------------------------------ |
| `SUB2API_DATABASE_URL`                 | 真实模式必填   | 单实例 PostgreSQL 只读连接地址             |
| `METERLEAF_SOURCE_ID`                  | `sub2api`      | 稳定来源标识；已有账本不要改名             |
| `METERLEAF_BIND_ADDRESS`               | `127.0.0.1`    | Compose 对外绑定地址                       |
| `METERLEAF_PUBLISHED_PORT`             | `4318`         | Compose 对外端口                           |
| `METERLEAF_SYNC_VISIBLE_INTERVAL_MS`   | `15000`        | 页面可见时的自动同步间隔，5 秒至 1 小时    |
| `METERLEAF_SYNC_HIDDEN_INTERVAL_MS`    | `60000`        | 页面不可见时的自动同步间隔，5 秒至 1 小时  |
| `METERLEAF_REPORT_REFRESH_INTERVAL_MS` | `300000`       | 报表后台刷新间隔，30 秒至 24 小时          |
| `METERLEAF_USD_BASIS`                  | `subscription` | 默认 USD 口径，也可选 `api`                |
| `METERLEAF_PRICE_BOOK`                 | 内置价格表     | 自定义完整价格 JSON 路径                   |
| `METERLEAF_LOG_LEVEL`                  | `info`         | `debug`、`info`、`warn`、`error`、`silent` |

Compose 将容器内数据目录、监听地址和端口固定为 `/app/app_data`、`0.0.0.0` 和 `4318`；`METERLEAF_DATA_DIR`、`METERLEAF_HOST`、`METERLEAF_PORT`、`METERLEAF_DEMO` 仅用于直接以 Bun 启动时的本地配置。

自定义价格文件可放在挂载的 `prices` 目录，设置 `METERLEAF_PRICE_BOOK=/app/prices/custom.json`。修改后更新费率版本并重启，详见[计价说明](pricing.md)。

## 首次采集与自动同步

首次启动默认不采集。在「数据同步」中点击「立即同步」启动历史补采；服务保持在线，重复点击不会建立并发任务。自动同步默认关闭，开关会保存在本地账本并在重启后恢复。

同步失败时保留已成功采集的账本，手动模式可重试，自动模式按配置间隔继续尝试；重启后可继续未完成采集。源端已清理的历史记录或未保留的额度快照无法补回。

账户额度来自 Sub2API 的缓存字段，新鲜度不能超过上游缓存。窗口过期后显示未知，不把上一周期消费带入新周期。

## 升级与备份恢复

升级前停止 Meterleaf，备份整个数据目录，并记录当前代码或镜像版本：

```sh
docker compose stop meterleaf
cp -a app_data "app_data.backup-$(date +%Y%m%d-%H%M%S)"
```

备份完成后按实际使用的来源择一更新并启动。

源码构建：

```sh
docker compose build
docker compose up -d --pull never
```

已发布镜像：

```sh
docker compose pull
docker compose up -d --no-build --pull never
```

更新后用 `docker compose ps` 检查状态。

恢复前先准备备份对应的程序版本，再停止服务、保留当前数据并恢复完整备份。将下面的备份目录替换为实际名称：

```sh
docker compose stop meterleaf
test ! -e app_data.before-restore
mv app_data app_data.before-restore
cp -a app_data.backup-YYYYMMDD-HHMMSS app_data
docker compose up -d --no-build --pull never
```

必须恢复整个数据目录，不要只复制运行中的 SQLite 主文件而遗漏 WAL。这些操作只针对 Meterleaf，无需停止 Sub2API。

升级会自动执行数据库迁移；遇到不兼容或无法识别的结构时服务会停止，不要通过清空数据绕过。

## 数据文件与缓存

备份需包含整个 `app_data`，其中保存了账本、账户状态和额度快照。报表缓存可从账本重建，首次查询可能需要等待；刷新页面不需要清空数据。

已有报表先返回上次成功结果，再后台更新；更新失败保留旧结果。USD 两种口径及三种单位可在同一结果中切换，无需重采源用量。

## 日志与排障

```sh
docker compose ps
docker compose logs --since 10m meterleaf
curl -fsS http://127.0.0.1:4318/api/health
curl -fsS http://127.0.0.1:4318/api/sync
```

健康接口只说明进程可响应；同步是否成功以 `/api/sync` 和日志中的阶段、错误类别为准。源端失败保留已有账本，不回退到演示数据。

| 现象               | 检查方向                                         |
| ------------------ | ------------------------------------------------ |
| 同步失败           | 查看界面错误编号和日志阶段，核对网络及只读权限   |
| 同步状态读取失败   | 检查浏览器、代理和服务响应；这不等于上游采集失败 |
| 报表更新失败       | 已有缓存应继续可读；检查报表读取错误后再重试     |
| 额度显示 `N/A`     | 核对上游缓存采样和重置时间，不用旧周期替代       |
| 缺少推理强度或费用 | 核对源记录字段与匹配费率，不用默认值补齐         |

日志为单行 JSON，排障时结合时间、阶段、错误类别和错误编号判断失败位置。
