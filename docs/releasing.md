# 版本与发布

产品版本取自 `package.json` 的 `version`，页面、Git 标签和镜像版本保持一致。数据库结构版本和价格表版本独立管理。

## 发布流程

1. 更新版本：`bun pm version patch --no-git-tag-version`，新增功能可用 `minor`，也可明确指定版本。
2. 将 `CHANGELOG.md` 未发布内容整理为 `## [版本号] - YYYY-MM-DD`，使用真实发布日期，保留新的未发布区。
3. 运行 `bun test tests`、`bun run build`，提交版本与更新说明，例如 `chore(release): prepare 0.1.1`。
4. 推送到 `main`。Release 工作流自动校验、测试和构建，创建版本标签，将 `linux/amd64`、`linux/arm64` 镜像同时发布到 GHCR 和 Docker Hub，并创建 GitHub Release。

版本未变时跳过自动发布。需要覆盖已有版本时，在 Actions 的 Release 工作流点击「Run workflow」，选择 `main`；这会按该提交重新构建，替换对应 Git 标签、同版本镜像及 Release 说明。

首次运行仍需按[部署指南](deployment.md)准备数据目录权限和来源配置。升级前备份完整数据目录，不执行删除数据卷的清理命令。
