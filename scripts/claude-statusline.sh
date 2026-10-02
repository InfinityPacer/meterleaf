#!/bin/bash
# 只保存 Claude Code 提供的额度窗口；不落盘完整状态栏输入或读取登录凭据。
set -eu
umask 077
cache="${METERLEAF_STATUSLINE_CACHE:-$HOME/Library/Application Support/Meterleaf Collector/statusline-quota.tsv}"
mkdir -p "$(dirname "$cache")"
pending=$(mktemp "$cache.tmp.XXXXXX")
trap 'rm -f "$pending"' EXIT
if ! jq -r '
  (.rate_limits // {}) | to_entries[]
  | select(.key == "five_hour" or .key == "seven_day")
  | select(.value | type == "object")
  | select(.value.used_percentage | type == "number")
  | select(.value.used_percentage >= 0 and .value.used_percentage <= 1000)
  | select(.value.resets_at | type == "number")
  | select(.value.resets_at >= 100000000 and .value.resets_at < 100000000000)
  | select(.value.resets_at == (.value.resets_at | floor))
  | [.key, .value.used_percentage, .value.resets_at] | @tsv
' > "$pending" 2>/dev/null; then
  exit 0
fi
# 无额度的消息不刷新旧快照时间；临时文件 + rename 避免采集到半行。
if [ -s "$pending" ]; then
  mv "$pending" "$cache"
  awk -F '\t' '{ printf "%s%s %s%%", (NR > 1 ? " · " : ""), ($1 == "five_hour" ? "5h" : "7d"), $2 } END { print "" }' "$cache"
fi
