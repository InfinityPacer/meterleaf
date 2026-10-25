# 更新日志

## [未发布]

## [0.12.7] - 2026-10-25

- 在 Paseo 之外用 `paseo run` 派出代理时，改用 `--label dispatched-by=<派出者的会话 ID>` 标明派出者，`scripts/claude-resume-visibility.ts` 会把它识别为子代理。此前文档建议的 `paseo.parent-agent-id` 不要在 Paseo 之外使用，上级不在 Paseo 里时，Paseo 不会自动为这个代理打开标签页，工作区的运行状态也不计入它。
- 版本与发布说明补充了发版时机和只保留最新版本的做法，见[版本与发布](docs/releasing.md)。
- 只需更新这个脚本，采集器和服务端都不用替换。数据库结构未变，升级无需先备份。
