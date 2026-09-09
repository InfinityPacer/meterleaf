import type { LedgerRecord, LedgerSnapshot } from "./report";
import type { Charge, Valuation } from "../domain/pricing";

type ChargeTuple = [
  Charge["amount"],
  Charge["basis"],
  Charge["reason"],
  boolean,
];
type ValuationTuple = [
  string,
  Valuation["usdBasis"],
  ChargeTuple,
  ChargeTuple,
  ChargeTuple,
  ChargeTuple,
];
const encodeCharge = (value: Charge): ChargeTuple => [
  value.amount,
  value.basis,
  value.reason,
  value.assumedStandard,
];
const decodeCharge = (value: ChargeTuple): Charge => ({
  amount: value[0],
  basis: value[1],
  reason: value[2],
  assumedStandard: value[3],
});
function encodeValuation(value: Valuation): ValuationTuple {
  return [
    value.version,
    value.usdBasis,
    encodeCharge(value.usd),
    encodeCharge(value.apiUsd),
    encodeCharge(value.subscriptionUsd),
    encodeCharge(value.credits),
  ];
}
function decodeValuation(value: ValuationTuple): Valuation {
  return {
    version: value[0],
    usdBasis: value[1],
    usd: decodeCharge(value[2]),
    apiUsd: decodeCharge(value[3]),
    subscriptionUsd: decodeCharge(value[4]),
    credits: decodeCharge(value[5]),
  };
}

const fields = [
  "id",
  "occurredAt",
  "accountId",
  "model",
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "usd",
  "credits",
  "tier",
  "quality",
  "priceVersion",
  "sourceId",
  "sourceRecordId",
  "gatewayCost",
  "gatewayBilled",
  "valuation",
  "details",
] as const satisfies readonly (keyof LedgerRecord)[];
export interface LedgerWire extends Omit<LedgerSnapshot, "records"> {
  format: "columns-v1";
  fields: readonly (keyof LedgerRecord)[];
  rows: unknown[][];
}

/** 列名只传一次，保持所有明细和精确金额，不截断统计或CSV所需记录。 */
export function encodeLedger(snapshot: LedgerSnapshot): LedgerWire {
  const { records, ...rest } = snapshot;
  return {
    ...rest,
    format: "columns-v1",
    fields,
    rows: records.map((record) =>
      fields.map((field) =>
        field === "valuation" && record.valuation
          ? encodeValuation(record.valuation)
          : (record[field] ?? null),
      ),
    ),
  };
}

/** 传输格式只在HTTP边界展开，页面和报表保持相同领域数据合同。 */
export function decodeLedger(
  value: LedgerSnapshot | LedgerWire,
): LedgerSnapshot {
  if (!("format" in value)) return value;
  if (value.format !== "columns-v1")
    throw new Error("Unsupported ledger format");
  const { format, fields: columns, rows, ...rest } = value;
  return {
    ...rest,
    records: rows.map(
      (row) =>
        Object.fromEntries(
          columns.map((field, index) => [
            field,
            field === "valuation" && row[index]
              ? decodeValuation(row[index] as ValuationTuple)
              : row[index],
          ]),
        ) as unknown as LedgerRecord,
    ),
  };
}
