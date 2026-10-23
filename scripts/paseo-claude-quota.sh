#!/bin/bash
# Paseo 的 Claude Code 启动包装：参数原样交给 claude，只从输出流里抄下额度事件。
# Paseo 以无界面模式运行 Claude Code，状态栏命令不会执行；但每次请求后 Claude Code 会在输出流里
# 发出 rate_limit_event，内容来自这次请求的响应头，与状态栏拿到的 5 小时、7 天额度相同。
# 脚本把它写成采集器读取的状态栏额度缓存，不读凭据、不发额外请求，也不改动 Paseo 收到的输出。
set -u
real="${METERLEAF_CLAUDE_BIN:-$HOME/.local/bin/claude}"
cache="${METERLEAF_STATUSLINE_CACHE:-$HOME/Library/Application Support/Meterleaf Collector/statusline-quota.tsv}"

# 接到其他接口（例如 OpenCode Go）或云厂商时，额度事件不属于 Claude 订阅，直接运行。
if [ -n "${ANTHROPIC_BASE_URL:-}" ] || [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] ||
  [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ]; then
  exec "$real" "$@"
fi

record_quota() {
  umask 077
  mkdir -p "$(dirname "$cache")" 2>/dev/null
  # grep 先筛掉绝大多数行，并且一直读到输出结束，保证 tee 不会因下游提前退出而中断。
  grep --line-buffered -F '"rate_limit_event"' | while IFS= read -r line; do
    pending=$(mktemp "$cache.tmp.XXXXXX" 2>/dev/null) || continue
    if printf '%s\n' "$line" | jq -r '
      select(.type == "rate_limit_event")
      | (.rate_limit_info.unifiedWindows // {}) | to_entries[]
      | select(.key == "five_hour" or .key == "seven_day")
      | select(.value.utilization | type == "number")
      | select(.value.resetsAt | type == "number")
      | [.key, ((.value.utilization * 10000 | round) / 100), (.value.resetsAt | floor)]
      | @tsv
    ' >"$pending" 2>/dev/null && [ -s "$pending" ]; then
      # 临时文件 + rename，采集器不会读到半行。
      mv "$pending" "$cache"
    else
      rm -f "$pending"
    fi
  done
}

# exec 之后本进程就是 claude，Paseo 的中断信号直接送达；输出经 tee 原样转交 Paseo。
exec > >(tee >(record_quota))
exec "$real" "$@"
