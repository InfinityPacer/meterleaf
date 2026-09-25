import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { amount, compact } from "../lib/report";

/** 四个计量桶互斥；推理 Tokens 属于输出，不单独成段。 */
export interface TokenComposition {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
}

/**
 * 摘要只接收已经算好的数：历史至今来自全历史累计，其余范围来自同一次报表查询。
 * change 为 null 表示该范围没有可比的上一时段（例如历史至今），不是零增长。
 */
export interface UsageSummaryData {
  tokens: number | null;
  usd: number | null;
  /** 订阅 Credits 与美元是不同依据；没有 Credits 用量时为 null 且不展示。 */
  credits: number | null;
  requests: number | null;
  cacheRate: number | null;
  composition: TokenComposition;
  change: {
    tokens: number | null;
    usd: number | null;
    requests: number | null;
  } | null;
  /** 历史至今的起点，展示在请求数下方。 */
  since: string | null;
  /** 历史至今按自然日平均；只在没有环比时展示。 */
  dailyUsd: number | null;
  dailyTokens: number | null;
  usdNote: string;
}

/** 命中率的分母是输入侧三个桶；输出不参与命中率，只作为数值附注。 */
const segments = [
  { key: "cacheRead", label: "缓存读取" },
  { key: "input", label: "输入" },
  { key: "cacheWrite", label: "缓存写入" },
] as const;

/** 环比仅比较上一个等长时段；上期为零或未知时不给百分比。 */
export function percentChange(
  current: number | null | undefined,
  previous: number | null | undefined,
) {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  )
    return null;
  return (current / previous - 1) * 100;
}

function Change({
  value,
  emphasize,
}: {
  value: number | null;
  emphasize?: boolean;
}) {
  if (value === null) return <span className="summary-change">暂无对比</span>;
  return (
    <span
      className={`summary-change ${emphasize && value > 0 ? "higher" : ""}`}
    >
      {value > 0 ? (
        <ArrowUpRight size={12} aria-hidden="true" />
      ) : (
        <ArrowDownLeft size={12} aria-hidden="true" />
      )}
      <span className="sr-only">{value > 0 ? "增加" : "减少"}</span>
      {Math.abs(value).toFixed(1)}% 环比
    </span>
  );
}

/** 输入侧构成按已知 Tokens 计算占比；未知的桶不画，也不补零。 */
export function CompositionBar({
  composition,
}: {
  composition: TokenComposition;
}) {
  const parts = segments
    .map((segment) => ({ ...segment, value: composition[segment.key] }))
    .filter(
      (part): part is typeof part & { value: number } =>
        part.value !== null && Number.isFinite(part.value) && part.value > 0,
    );
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return null;
  return (
    <div className="token-composition">
      <div className="token-composition-bar" aria-hidden="true">
        {parts.map((part) => (
          <span
            key={part.key}
            data-segment={part.key}
            style={{ flexGrow: part.value }}
            title={`${part.label} ${compact(part.value)}`}
          />
        ))}
      </div>
      <ul className="token-composition-legend" aria-label="Tokens 构成">
        {parts.map((part) => (
          <li key={part.key} data-segment={part.key}>
            <i aria-hidden="true" />
            {part.label}
            <span>{((part.value / total) * 100).toFixed(1)}%</span>
          </li>
        ))}
        {composition.output !== null && (
          <li data-segment="output">
            输出<span>{compact(composition.output)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

export function UsageSummary({
  data,
  label,
  updating = false,
}: {
  data: UsageSummaryData;
  label: string;
  /** 新范围仍在读取时沿用上一次结果，数字需要标成正在更新。 */
  updating?: boolean;
}) {
  const since = data.since
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(data.since))
    : null;
  return (
    <section
      className="lifetime-summary usage-summary"
      aria-label={label}
      aria-busy={updating}
    >
      <dl>
        <div>
          <dt>Tokens</dt>
          <dd>{compact(data.tokens)}</dd>
          <small>
            {data.change ? (
              <Change value={data.change.tokens} />
            ) : data.dailyTokens !== null ? (
              `日均 ${compact(data.dailyTokens)}`
            ) : null}
          </small>
        </div>
        <div>
          <dt>费用</dt>
          <dd>{amount(data.usd, "usd")}</dd>
          {!data.change && data.dailyUsd !== null && (
            <small>日均 {amount(data.dailyUsd, "usd")}</small>
          )}
          <small>
            {data.usdNote}
            {data.change ? (
              <>
                {" · "}
                <Change value={data.change.usd} emphasize />
              </>
            ) : null}
          </small>
          {data.credits !== null && (
            <small className="summary-credits">
              订阅 Credits {amount(data.credits, "credits")}
            </small>
          )}
        </div>
        <div>
          <dt>请求</dt>
          <dd>
            {data.requests === null ? "N/A" : data.requests.toLocaleString()}
          </dd>
          <small>
            {data.change ? (
              <Change value={data.change.requests} />
            ) : since ? (
              `${since} 起`
            ) : null}
          </small>
        </div>
        <div className="usage-summary-cache">
          <dt>缓存命中率</dt>
          <dd>
            {data.cacheRate === null ? "N/A" : data.cacheRate.toFixed(1)}
            {data.cacheRate !== null && <small>%</small>}
          </dd>
          <CompositionBar composition={data.composition} />
        </div>
      </dl>
    </section>
  );
}
