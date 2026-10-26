# 版本与发布

产品版本取自 `package.json` 的 `version`，页面、Git 标签和镜像版本保持一致。数据库结构版本和价格表版本独立管理。

## 发布流程

1. 更新版本：`bun pm version patch --no-git-tag-version`，新增功能可用 `minor`，也可明确指定版本。
2. 运行 `bun test tests`、`bun run build`，提交版本，例如 `chore(release): prepare 0.1.1`。
3. 推送到 `main`。Release 工作流自动校验、测试和构建，创建版本标签，将 `linux/amd64`、`linux/arm64` 镜像同时发布到 GHCR 和 Docker Hub，并创建 GitHub Release。

## 什么时候发版

合并到 `main` 的提交只要改了 `package.json` 的版本，Release 工作流就会发布一个新版本。所以一件事讨论中的后续修正先留在同一个分支上，规则定下来后一次合并、一次发版，不要每改一轮就升一次版本。只改仓库里的可选脚本或文档、不影响镜像和采集器时，可以不升版本，等下一次正式发版一起发布。

版本未变时跳过自动发布。需要覆盖已有版本时，在 Actions 的 Release 工作流点击「Run workflow」，选择 `main`；这会按该提交重新构建，替换对应 Git 标签和同版本镜像。

首次运行仍需按[部署指南](deployment.md)准备数据目录权限和来源配置。不执行删除数据卷的清理命令。

升级时是否需要先备份，取决于数据库结构版本（`src/storage/schema.ts` 中的 `DATABASE_SCHEMA_REVISION`）有没有变化。没有变化时，旧版本镜像仍能读取升级后的数据，回滚只需换回旧镜像标签，不必为升级单独备份。有变化时，旧版本读不了迁移后的数据库，升级前必须停止服务并备份完整数据目录。
