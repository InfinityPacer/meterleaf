# 更新日志

## [未发布]

## [0.12.4] - 2026-10-25

- 本机采集器可以登记额外任务：`meterleaf-collector tasks add` 登记一条本机命令，由采集器的后台任务按间隔运行，有限时，失败只记日志，不影响同步，`status` 和 `tasks` 显示最近一次结果。用法见[本机采集器](docs/collector.md#额外任务可选)。
- 新增可选脚本 `scripts/claude-resume-visibility.ts`，登记为额外任务后，你在 Paseo 里对话过的 Claude Code 会话会出现在 `claude --resume` 的会话列表里。子代理和仍在运行的会话不处理，改动可以按记录改回。
- 需要重新构建并替换本机采集器，服务端不用升级。数据库结构未变，升级无需先备份。
