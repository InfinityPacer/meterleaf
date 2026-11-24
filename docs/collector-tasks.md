# 采集器辅助脚本与额外任务

[返回本机采集器](collector.md) · [返回首页](../README.md)

本页介绍配合本机采集器使用的可选辅助脚本与额外定时任务，包括无界面 Paseo 额度捕获、额外任务调度、Paseo 会话恢复列表可见性修正，以及额度周期到期/重置自动预热。这些脚本全部是可选能力，不影响采集器本身的只读承诺。

## 通过 Paseo 使用 Claude Code

Paseo 以无界面模式启动 Claude Code，状态栏命令不会执行，额度缓存因此停在最后一次在终端使用的时候，页面上的 5 小时窗口长期显示「等待更新」。无界面模式下，Claude Code 每次请求后会在输出流里给出同样的 5 小时与 7 天额度，Paseo 收到后并不保存。仓库里的 `scripts/paseo-claude-quota.sh` 包在 Claude Code 外面，参数和输入原样交给它，Paseo 收到的输出不变，脚本只把其中的额度写进[状态栏额度缓存](collector.md#状态栏额度缓存可选)文件。

先把脚本复制到不随仓库分支变化的位置，Paseo 每次启动 Claude 代理都要用到它，文件不在时代理无法启动。

```sh
install -m 755 scripts/paseo-claude-quota.sh ~/.local/bin/meterleaf-paseo-claude
```

再在 `~/.paseo/config.json` 中把 Claude 的启动命令换成安装后的绝对路径（需要 `jq`），执行 `paseo reload`。之后新启动的 Claude 代理生效，已在运行的代理要重新开始才会经过脚本。

```json
{
  "agents": {
    "providers": {
      "claude": {
        "command": ["/Users/you/.local/bin/meterleaf-paseo-claude"],
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

## 额外任务（可选）

采集器的后台任务每分钟运行一次。需要在这台电脑上定期跑的小脚本，可以登记为额外任务，由同一个后台任务按间隔运行，不必再单独安装定时任务，`status` 里也能一起看到。

```sh
meterleaf-collector tasks add <名称> --every 10 --timeout 60 -- /绝对路径/命令 参数...
meterleaf-collector tasks            # 列出任务和最近一次结果（等价于 tasks list）
meterleaf-collector tasks run <名称> # 立即运行一次并显示输出
meterleaf-collector tasks remove <名称>
```

- `--` 之后是要运行的命令，第一项必须是可执行文件的绝对路径，其余原样作为参数，不经过 shell。名称只能用小写字母、数字和 `-`（必须以字母或数字开头，最长 40 个字符），最多登记 20 个任务。
- `--every` 是间隔分钟数，范围 1 到 1440，默认 10；`--timeout` 是限时秒数，默认 60，最长 600。任务结束或超时时，它启动的子进程会一起结束；脱离进程组自行运行的进程不受管理，但不会拖住同步。同名任务用 `--force` 覆盖。
- 任务在每轮同步之后按登记顺序运行，与同步共用一把运行锁，所以不会和自己重叠，也不会与 `tasks run` 同时运行。服务端暂时连不上时任务照常运行。
- 任务失败或超时只写进 `logs/collector.err.log`，不影响同步和其他任务。成功且没有输出时不写日志。
- 任务的工作目录是数据目录下的 `tasks/<名称>`，可以在这里保存自己的状态，删除任务时不会一并删除。任务还能从环境变量读到 `METERLEAF_TASK_NAME`、`METERLEAF_TASK_STATE_DIR`，以及 `METERLEAF_CLAUDE_CONFIG_DIRS`，后者每行一个 Claude 配置目录，默认目录在前，随后是[登记的额外账户](collector.md#登记额外账户)。

后台任务以低优先级运行，任务也一样。任务做什么由你负责，采集器不检查它读写哪些文件。

## 让 Paseo 会话出现在 resume 列表

Paseo 以无界面模式启动 Claude Code，这样产生的会话不会出现在 `claude --resume` 和 `/resume` 的会话列表里，只能用会话 ID 打开。Claude Code 是按会话记录开头标着的启动来源决定是否列出的，与会话内容无关。

仓库里的 `scripts/claude-resume-visibility.ts` 把你在 Paseo 里开的主会话改成按普通终端会话列出。它只处理同时满足下面两点的会话。

- 属于某个 Paseo 代理，也就是 Paseo 恢复这个代理时用的那个 Claude 会话。
- 这个代理是你开的，不是其他代理派出的。Paseo 内派出的代理带有父代理标签，第一条消息也是上级代理转来的任务，这样的子代理即使之后你直接和它对话过，也不会被列出。在 Paseo 之外，例如普通终端里的 Claude Code 用 `paseo run` 派出的代理，Paseo 不记录派出者，看起来和你开的一样。派出时加上 `--label dispatched-by=<派出者的会话 ID>` 就会被识别为子代理，在终端的 Claude Code 里可以用 `--label "dispatched-by=$CLAUDE_CODE_SESSION_ID"`。不要用 `paseo.parent-agent-id` 代替，Paseo 会把带这个标签的代理当成那个上级代理的子代理，上级不在 Paseo 里时，不会自动为它打开标签页，工作区的运行状态也不计入它。

在 Paseo 里仍开着的代理也会列出。想在终端里接着用时，先在 Paseo 里归档它。Paseo 那边的进程不知道终端里新增的对话，之后在 Paseo 里再发消息，会从它自己的最后一条接着写，两边的对话就分叉了。

改动只涉及会话记录开头那一段的启动来源字段，在原位置写入同样长度的内容，文件大小不变，对话内容不动。Claude Code 只在文件末尾追加，即使会话正在进行也不会和这里的写入冲突，采集器也不会因此重新读取这些文件。

先复制到不随仓库分支变化的位置，用 `--dry-run` 看看会列出哪些会话，再登记为额外任务。

```sh
install -m 755 scripts/claude-resume-visibility.ts ~/.local/bin/meterleaf-resume-visibility
~/.bun/bin/bun ~/.local/bin/meterleaf-resume-visibility --dry-run
meterleaf-collector tasks add resume-visibility -- "$HOME/.bun/bin/bun" "$HOME/.local/bin/meterleaf-resume-visibility"
meterleaf-collector tasks run resume-visibility
```

脚本从 `~/.paseo` 读取代理记录，Paseo 数据目录不在这里时，用 `PASEO_HOME` 指定。每一处改动都记在数据目录的 `tasks/resume-visibility/changes.jsonl`。想恢复原状，先 `tasks remove resume-visibility`，再运行一次 `--revert`，带上 `METERLEAF_TASK_STATE_DIR` 指向这个目录。

```sh
METERLEAF_TASK_STATE_DIR="$HOME/Library/Application Support/Meterleaf Collector/tasks/resume-visibility" \
  ~/.bun/bin/bun ~/.local/bin/meterleaf-resume-visibility --revert
```

这依赖 Claude Code 当前的会话记录格式。以后 Claude Code 换了判断方式，最坏的结果是这些会话重新不在列表里，用会话 ID 仍然可以打开。

## 额度到期与重置自动预热（开窗）

Antigravity（各实例的 Gemini 与 Claude/GPT 池）和 Codex 的 7 天周窗口与 5 小时窗口，都是在上一周期到期或被上游重置后的第一笔请求时才起算新周期。如果窗口在电脑睡眠或闲置期间到期或重置，新周期的重置时间就会往后顺延。

仓库里的 `scripts/quota-warmup.ts` 检查本机已有的 Antigravity 状态栏额度缓存（含默认实例与同级 `antigravity-cli-<name>` 额外实例）和 `$CODEX_HOME/sessions` 最新会话（最多最新 15 个未压缩 `.jsonl`）的额度通知。已启用的 Antigravity 账号如果本地缓存缺失或较旧，会按带随机抖动的间隔（默认 50–80 分钟）执行一次只读 `agy -p /usage`（不调用模型、不消耗额度）以发现上游中途提前重置；上游重置后还没有请求的窗口，agy 可能报「未开窗」，也可能报一个从查询时刻起算整个窗口长度（容许 5 分钟误差）、没有用量的重置时间，后者每查一次都往后顺延，巡检时同样按未开窗（`0\t0`）记录。一旦发现窗口已到期或处于未开窗状态，就随机挑一条极简问候语（`ok`、`hi` 等），用该池最廉价的模型发一次单轮请求触发新周期开窗：

- **Antigravity Gemini 池**（`gemini_weekly` / `gemini_5h`）：调用 `gemini-3.8-flash-low`，随后执行一次 `agy -p /usage` 把新周期写回状态栏缓存。
- **Antigravity 第三方池**（`3p_weekly` / `3p_5h`）：优先调用 `gpt-oss-120b-medium`（失败时回退 `claude-sonnet-5-5-low`），随后执行一次 `agy -p /usage` 刷新缓存。
- **Codex**（`seven-day` / `five-hour`）：在临时目录下调用 `codex exec --ignore-user-config`（指定 `openai` 通道、`gpt-6-luna`、`low` 推理档位与仅单字回复指令），产生的会话记录由下一轮采集器同步自动读取新周期额度。

默认只预热 7 天周窗口；传入 `--codex-5h`（或 `METERLEAF_WARMUP_CODEX_5H=1`）时一并预热 Codex 的 5 小时窗口，传入 `--include-5h`（或 `METERLEAF_WARMUP_5H=1`）时预热全部来源的 5 小时窗口。每个已成功预热的旧周期在 `tasks/quota-warmup/state.json` 里记录，只触发一次；未开窗状态（`0\t0`）按 30 分钟冷却避免重复刷屏；如果当轮失败，下一轮任务（5 分钟后）会自动重试。支持环境变量 `METERLEAF_AGY_STATUSLINE_DIR`、`METERLEAF_AGY_CONVERSATIONS_DIR`、`CODEX_HOME`、`AGY_BIN`、`CODEX_BIN` 覆盖默认路径。

需要按账号、按池子或按窗口（`5h` / `7d`）分别控制开关，或调整只读 `/usage` 刷新的随机间隔时，可在 `tasks/quota-warmup/config.json`（与 `state.json` 同目录，也可用 `METERLEAF_WARMUP_CONFIG` 指定路径）里编写配置：

```json
{
  "usageRefreshMinutes": { "min": 50, "max": 80 },
  "defaults": { "enabled": true, "5h": false, "7d": true },
  "accounts": {
    "codex": { "enabled": true, "5h": true, "7d": true },
    "agy:tern": { "enabled": true, "5h": true, "7d": true },
    "agy:tide": { "enabled": true, "5h": false, "7d": true },
    "agy:owl": {
      "enabled": true,
      "gemini": { "5h": true, "7d": true },
      "3p": { "5h": false, "7d": true }
    }
  }
}
```

`defaults` 适用于未单独列出的账号（含后续新增账号）；`accounts` 支持 `codex`（或 `codex:default`）与 `agy:<账号标签>`（也可按 `agy:@<实例名>` 或 `agy:<实例名>` 兜底匹配，精确标签优先），将某账号设为 `enabled: false` 会同时跳过它的只读 `/usage` 巡检与全部预热。`5h` 开关的优先级为：池级配置 > 账号级配置 > 命令行参数 / 环境变量 > `defaults` > 内置默认（`false`）。

```sh
install -m 755 scripts/quota-warmup.ts ~/.local/bin/meterleaf-quota-warmup
~/.bun/bin/bun ~/.local/bin/meterleaf-quota-warmup --dry-run --codex-5h
meterleaf-collector tasks add quota-warmup --every 5 --timeout 120 -- "$HOME/.bun/bin/bun" "$HOME/.local/bin/meterleaf-quota-warmup" --codex-5h
meterleaf-collector tasks run quota-warmup
```
