# 计价说明

[返回首页](../README.md)

Meterleaf 将费率保存在独立 JSON 文件中，内置文件为
`prices/meterleaf-2026-10-30.json`，同时包含 OpenAI、Anthropic Claude、Google Gemini 与 Vertex AI 模型，以及通过 OpenCode Go 接入的 DeepSeek 与 GLM 模型。使用自定义价格表时，设置
`METERLEAF_PRICE_BOOK=/path/to/prices.json` 并重启服务。自定义文件完整替换内置表，不进行隐式合并。

## 版本元数据

- `schemaVersion`：JSON 格式版本，当前为 `1`。
- `id` 与 `version`：价格表身份和费率修订版本。
- `supersedes`（可选）：本价格表接替的旧 `id`。只在给同一套价格改名时使用，升级后页面缓存的旧结果可以继续保留到重新计算完成。
- `publishedAt`：UTC 观测或发布时间。
- `unit`：计价单位，固定为 `per_million_tokens`，即每百万 token。
- `sources`：费率依据；`notes` 可记录假设、限制和促销说明。

完整修订标识为 `id@version`。账本保存完整价格表和估值使用的修订标识；修改已入库的价格表必须更新版本，同一个修订标识不能对应不同内容。引入新版本不会删除历史价格表。

## 计价分支

每条规则匹配 `model`、`tier`、`currency` 和左闭右开的有效时间段
`[effectiveFrom, effectiveUntil)`；`effectiveUntil` 可省略。USD 规则还必须指定 `usdBasis`：

- `subscription`：订阅等价 USD，默认展示口径。内置规则使用已公布的基础美元费率，不应用长上下文加价。
- `api`：标准 API USD，保留已公布的长上下文档位。

Credits 使用独立规则，不设置 `usdBasis`。两个 USD 分支与 Credits 都由相同用量事实独立计算；界面切换只影响 USD 估算，不改变 Tokens、订阅周期或 Credits。订阅等价 USD 不是订阅账单，也不是固定的 Credits 与美元兑换关系。

来源中的 API 账户只表示接入方式，其真正上游仍可能是订阅账户。
账户类型不会自动切换 USD 口径，也不会排除 Credits 参考估值。
额度与周期依赖实际快照；未提供快照时显示未知，不能据此断言上游没有订阅额度。

## Token 与费率

`rates` 包含 `input`、`cacheRead`、`cacheWrite` 和 `output`，各项为每百万 token 的十进制字符串费率。这些 token 桶互斥；推理 token 和缓存写入 TTL 子桶不能再次相加。

可选的 `cacheWrite1h` 是 1 小时缓存写入的费率。配置后，缓存写入中属于 1 小时的部分按它计价，其余按 `cacheWrite` 计价。Claude 的 1 小时写入价是基础输入价的 2 倍，5 分钟写入是 1.25 倍，混用会明显低估费用。记录有缓存写入却没有 1 小时拆分时，已知的 5 分钟部分按 5 分钟价计，其余按 1 小时价计，因为 Claude Code 默认写入 1 小时缓存，且按较高一档不会低估费用；规则没有 `cacheWrite1h` 而记录含 1 小时写入时同样未计价，不按 5 分钟价凑数。

`null` 表示没有可用费率，不是零价。当对应 token 数量为正但费率为 `null` 时，估值保留为未计价。缺少任一基础 token 桶或匹配规则时，也保留为未计价。
可选的 `longContext` 指定 `threshold` 和替代 `rates`；只有总输入 Tokens 严格超过阈值才使用该档位，总输入包含普通输入、缓存读取和缓存写入。来源未声明档位时按 Standard 估值并标注为假设，不从其他档位或缺失费率推导。

可选的 `peak` 表示供应商公布的时段价，包含 `days`、`hoursUtc` 和替代的 `rates`。`days` 使用 ISO 星期编号，周一为 1、周日为 7；`hoursUtc` 的每个时段从 `from` 开始，到 `until` 前结束，写成 `HH:MM` 的 UTC 时间。判断记录是否处于峰时只看 `occurredAt` 换算后的 UTC 星期和时刻，与服务器或采集机器的本地时区无关。峰时费率是完整价格，不按倍率从基础费率推导；峰时与 `longContext`、`imageRates` 不能配置在同一条规则里，避免两套替代费率互相覆盖。

Sol 的已公布促销价已经写入两个 USD 分支，不再额外乘以 `0.8`；`promotion.confirmedThrough` 只表示至少确认到该日期。Astra Credits 超过 272K 后按选定订阅规则继续使用标准上下文费率。

GPT-5.6 的 Credits 使用对应模型的标准 Token 费率，不套用 API 长上下文加价。

图像规则可指定 `imageRates`，分别配置图像输入、缓存读取和输出的费率。
图像 Tokens 是现有输入、缓存和输出总量的子集，计价时先拆出，再按各自费率相加，不重复累计 Tokens。

### 内置价格与缺失规则

具体金额、模型覆盖和来源链接以 [内置价格 JSON](../prices/meterleaf-2026-10-30.json) 为准，文档不另行维护一份费率表。内置表是特定版本的观测快照，不保证与供应商未来价格实时一致。

Claude 规则使用 Anthropic 公布的 API 价格，订阅等价 USD 与标准 API USD 使用相同基础价，它们都是估值，不是 Claude 订阅账单。只收录官方模型页列出的模型 ID 与别名，其他 Claude 模型保留未计价。Opus 5.5、Opus 5 与 Opus 4.8 的快速模式记为 `priority` 档，按快速模式基础价再叠加缓存倍率。仅限美国推理的 1.1 倍加价和网页搜索按次费用不计入。

GPT-5.4 与 Mini 使用各自规则，不相互继承长上下文档位；未配置的 Fast、Flex 或缓存写入费率不会从标准档推导。Codex 快速模式的 Credits 记为 `priority` 档，按官方公布的倍数配置，GPT-5.6 与 GPT-6 各型号为标准档的 2.5 倍，GPT-6.1 各型号为标准档的 2 倍，GPT-5.4 为 2 倍，GPT-5.4 Mini 未公布，保留未计价。内置表的促销说明只描述该版本已采用的规则，不能据此假设促销结束后的价格。

内置表覆盖 GPT Image 2、GPT Image 2.5 Sunburst 和 Flare，以及各自已公布的日期快照。两代图像模型配置相同的 USD 和 Credits Token 单价。

通过 OpenCode Go 接入的 DeepSeek V4.1 Flash 使用 Go 公布的每百万 token 价格，并按 Go 公布的峰时规则区分工作日峰时与非峰时。这是该模型目前唯一可用的按 token 计价依据，两个 USD 分支都按它估值。Go 订阅按月计费，不随 token 用量出账，所以这些金额是估值而不是 Go 账单。该模型未公布缓存写入价，含缓存写入的记录保留未计价。

GLM-5.3-Flash 同样按 Go 公布的每百万 token 价格估值，这一价格与智谱公布的官方价相同。没有峰时区分，缓存写入价 Go 未公布，保留未计价。

GPT-6.1 Sol 与 Terra 按各自模型页公布的输入、缓存读取、缓存写入与输出价格估值；API 美元分支包含超过 272K 输入后的长上下文档位，订阅等价美元不含。Codex 的 Credits 按官方 Token 费率卡配置；GPT-6.1 Terra 的缓存写入公布的是 30 分钟保留价，Codex 记录没有写入 TTL 拆分，12 小时的另一档价不单独配置。快速模式的 Credits 按官方公布的 2 倍记为 `priority` 档。

`codex-auto-review` 没有自己的公布价。OpenAI 把 Codex 的自动评审请求路由到 `gpt-6-luna` 执行，所以这个模型按 luna 的公布费率估值，价格说明里写明了这一路由事实。它是估值的依据说明，不是独立费率条目。

Antigravity 使用的模型同样按官方公开的每百万 token 费率估值，不是 Google AI Ultra 订阅账单。`gemini-4-argon` 与 `gemini-3.8-flash` 采用 Google Gemini API 与 Vertex AI 公布的标准档与 Flex 档价格，按有效日期分段记录促销期与促销结束后的标准费率，官方没有按输入长度分档，未公布按 token 写入单价的缓存写入保留未计价。`claude-opus-5-5` 与 `claude-sonnet-5-5` 使用 Anthropic 官方模型价格，采集器把带思考档位后缀的响应模型名归一到这两个基础模型 ID。`gpt-oss-120b` 采用 Google Cloud Vertex AI Model Garden 公布的 `openai/gpt-oss-120b-maas` 托管价格，该模型未公布缓存读写折扣，含非零缓存读写的记录保留未计价。历史会话中出现的 `claude-opus-4-6-thinking` 是开启思考的 Opus 4.6，思考 token 按输出计价，归一到 `claude-opus-4-6` 并使用其官方费率。

未配置的模型不会自动别名到其他模型。网关参考价不是已核实的官方报价，也不能用于推导订阅 Credits。图像与实时模型需要相应媒体 Token 分桶，不能用文本四桶冒充完整费用。

排查缺失金额时，依次核对计价模型、服务档位、币种、USD 口径、有效日期和实际使用的 Token 桶。来源缺价时的零费用不是免费的证据；Meterleaf 保留未知值。

早于价格表观测时间的历史记录会标记为按当前费率重估，不视为历史账单。
上游直接报告的金额、网关扣费和本地独立估值始终区分保存。

Sub2API 的计价模型优先使用 `upstream_model`，缺失时使用源记录的 `model`。`upstream_response_model` 与 `upstream_model_mismatch` 只作为审计元数据；响应模型可能是别名，不自动覆盖计价模型。缺失字段不推断为一致。

## 自定义示例

```json
{
  "schemaVersion": 1,
  "id": "custom-example",
  "version": "2026-09-08.1",
  "publishedAt": "2026-09-08T00:00:00Z",
  "unit": "per_million_tokens",
  "sources": ["自定义计价示例，并非供应商价格"],
  "rules": [
    {
      "model": "my-model",
      "tier": "standard",
      "currency": "usd",
      "usdBasis": "subscription",
      "effectiveFrom": "2026-09-08T00:00:00Z",
      "rates": {
        "input": "1",
        "cacheRead": "0.1",
        "cacheWrite": null,
        "output": "5"
      }
    }
  ]
}
```

此示例只定义一个分支。该模型的标准 API USD 和 credits 在补充各自规则前均保持未计价。
缺失规则不会静默回退到另一种币种或 USD 口径。
