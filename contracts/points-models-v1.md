# 点数、模型与资料接口 v1

2026-10-01。本地实现契约；上线状态以 CURRENT_STATE 为准。以下接口均沿用同一 Bearer 登录会话、已有错误封装与禁用账号规则。

## 点数规则

- `pointsAvailable = pointsBalance - pointsReserved`，正可用余额才允许浮窗、导入和 AI 请求；基础功能本身不扣点，会员/试用字段为旧客户端兼容保留，不再决定新权限。
- 内置模型成功返回有效答案后按固定档位结算。先原子预占、后扣点；失败、供应商超时、处理中退出登录/禁用/模型变更不扣点，释放预占。
- 自带 API Key 每次平台扣 0 点，仍须正可用余额；供应商是否收费由供应商决定。
- 1 点：`doubao-mini`、`doubao-lite`、`qwen-plus`、`minimax-2-5`、`minimax-2-7`、`glm-4-7`。
- 2 点：`doubao-pro`（显示豆包 2.1 Pro）、`glm-5`、`glm-turbo`。

## GET /v1/models/catalog

需登录。响应：

```json
{
  "items": [{"key":"doubao-mini","name":"豆包 Mini","provider":"doubao","pointsPerCall":1,"configured":false,"available":false,"unavailableReason":"MODEL_NOT_CONFIGURED"}],
  "byokProviders": [{"id":"deepseek","name":"DeepSeek","baseUrl":"https://api.deepseek.com"}],
  "pointsAvailable":10,
  "policy":{"basicRequiresPositivePoints":true,"basicPointsPerUse":0,"byokPointsPerCall":0}
}
```

`items` 固定返回上述 9 个产品 key。`configured` 表示管理员明确绑定了真实配置；`available` 还要求启用、真实测试通过、密钥可用、点数足够。没有配置的条目不得假装已可用。`unavailableReason` 可为 `MODEL_NOT_CONFIGURED`、`MODEL_CONFIG_MISMATCH`、`MODEL_KEY_NOT_CONFIGURED`、`MODEL_NOT_VERIFIED`、`MODEL_DISABLED`、`INSUFFICIENT_POINTS`。

管理员现有模型 POST/PATCH 新增可选 `catalogKey`，绑定后 `pointsPerCall` 固定按产品档位。真实供应商 `modelId` 由管理员输入并测试，不从显示名推断。旧未绑定模型仍可管理/测试，但不混入固定目录。

## POST /v1/ai/search

需登录及 `Idempotency-Key`（每次用户发起新请求使用新键；网络重试沿用同一键及原请求）。本接口为模型答题，不声称已完成网页搜索或本地题库匹配。

内置请求：

```json
{"mode":"builtin","modelKey":"doubao-mini","question":"题干以及选项正文"}
```

自带 Key：

```json
{"mode":"byok","question":"题干以及选项正文","byok":{"provider":"deepseek","modelId":"供应商实际模型ID","apiKey":"本次使用的Key"}}
```

`question` 1–16000 字符。`byok.provider` 可为目录中的官方提供商；`custom` 时须给 `baseUrl`，且必须与 `byokProviders` 返回的官方 HTTPS 地址严格匹配。其他提供商的 `baseUrl` 可省略，提供时也须严格匹配。不允许任意代理地址、IP、重定向或内网地址。Key 仅留在本次服务端内存，不写数据库、日志或接口响应。

成功响应：

```json
{"requestId":"ai_...","status":"completed","source":"ai","model":{"key":"doubao-mini","name":"豆包 Mini","provider":"doubao","mode":"builtin"},"answer":"答案","explanation":"解析","pointsCharged":1,"pointsAvailable":9,"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}
```

相同键的已完成请求返回原答案与当前余额，不再次调用/扣费；进行中返回 409 `AI_REQUEST_PENDING`，客户端稍后以相同键和请求重试。失败请求同键重试重放失败，不自动重发给供应商；用户显式重新尝试应生成新键。相同键换题/模型/Key 为 409 `IDEMPOTENCY_CONFLICT`。

客户端断连或切页不会自动取消已发给供应商的请求：若取得有效答案，答案回执和扣点原子提交，稍后可取回；没有有效答案则释放预占。客户端不得因为没有收到响应就用新幂等键自动重发。每次预占截止为供应商超时加 15 秒；启动及每 15 秒恢复过期项，进程崩溃不会留下永久预占。

错误沿已有 `{error:{code,message,requestId,retryable}}`：403 `POINTS_REQUIRED`、402 `INSUFFICIENT_POINTS`、503 `MODEL_UNAVAILABLE`、409 `MODEL_CHANGED`，及明确的供应商认证/余额/限流/超时/无有效答案错误。无成功答案不扣平台点数，供应商侧超时是否产生费用无法保证，不自动重试供应商。

## GET /v1/ai/receipt

需登录及原 `Idempotency-Key` 请求头。不需要题干或 API Key，不发送供应商请求，只查询当前用户的持久回执：

- 已完成：返回与 `/v1/ai/search` 相同的成功结构，`pointsAvailable` 为当前可用余额；余额为 0 也允许取回答案，不再扣点。
- 处理中：409 `AI_REQUEST_PENDING`。过期项会先被恢复为失败并释放预占。
- 已失败：返回此前的安全错误和状态码，不再次调用供应商。
- 当前用户没有该请求：404 `AI_REQUEST_NOT_FOUND`，不会返回其他账号的状态或内容。

客户端可在发请求前按当前账号保存幂等键，连接恢复或进程重启后查询回执。不得为了恢复回执持久化 API Key。已退出登录或被禁用的会话仍被正常拒绝；同一用户重新登录后可读取自己的回执。

## 账户与资料

- `GET /v1/me` 和认证响应的 `account` 增加 `displayName`、`avatarId`。
- `entitlements` 保留 `floatingAllowed`、`aiAllowed`，增加 `importAllowed`、`byokAllowed`、`builtinAiAllowed`。基础原因变为 `points_positive` / `points_empty` / `disabled`；授权缓存上限仍为 15 分钟。
- `builtinAiAllowed` 是账户层按已绑定模型与余额给出的准入提示；具体型号是否配置、密钥能否解密，以 `/v1/models/catalog` 和调用时校验为准。供应商实时可用性只能由真实请求确认。
- `PATCH /v1/me/profile`：`{displayName?,avatarId?}`，至少一项；显示名 1–128 字符；头像仅 `pinterest-01` 至 `pinterest-06` 或 null。响应 `{principal,account}`。不需要提交点数/会员，不允许修改这些字段。
- 模型选择、外观、AI 回退偏好由客户端按用户隔离保存；API Key 不随这些偏好持久化。
- 兑换服务尚无已核对套餐或兑换码来源，本轮不伪造充值/兑换成功。

## 导入复审与目录汇总

- `POST /v1/imports`、预览修改、确认入库及人工新增题目在写入前校验正可用点数；既有读取与本人删除不因零点被禁止。
- `GET /v1/imports/:id/questions?order=review&offset=0&limit=50`：全局待核对优先，同组按原编号；每项增加 `ordinal` 原题号。返回 `items,total,revision,reviewQuestionCount,offset,nextOffset`。省略 `order` 保持原顺序；始终用 `questionId` 修改具体题目。
- `GET /v1/banks` 的每条 `item` 增加 `typeCounts`，按现有题型字段汇总。目录分页不变。

## 验收边界

当前实现见下方 Coze 接入章节。没有自动迁移真实余额、创建真实模型配置、调用生成模型或部署。提供商地址依据官方公开 API 文档；未配置产品槽位的名称不代表该账户已获对应实际型号权限。

## Coze 项目内置模型执行（2026-10-01）

客户端仍使用 `/v1/models/catalog`、`/v1/ai/search` 和 `/v1/ai/receipt`。内置模式的账号校验、预占、幂等键、成功结算及回执继续留在账号服务端；Coze 只负责生成。用户自带 Key 继续调用对应供应商官方接口，不经 Coze 项目模型集成。

管理员模型配置增加 `execution: "official" | "coze"`，旧配置默认 `official`。Coze 配置必须绑定产品计点档位，`baseUrl` 为 null，不接受 `apiKey/removeKey`，不会保存供应商密钥。实际型号必须出现在 SDK `listModels()` 返回列表中，并支持文本输入／输出；品牌和型号族与计点档位匹配。显示名称从真实元数据读取。豆包不同版本的 Pro 可进入 Pro 的 2 点档，但始终显示实际版本，不把 Seed 2.0 宣称为 2.1。

`GET /v1/admin/coze-models` 仅限管理员，返回 `{projectId,environment,items}`。读取元数据不会调用生成模型。保存配置不会自动启用；管理员明确发送一次固定 `OK` 检查、获得真实用量与正确结果后才能启用。修改接入方式、实际 ID、能力或输出预算会使原测试失效。`bridgeReady` 只表示桥配置完整，不代表实时调用成功；最终以真实检查和每次调用结果为准。

服务端通过固定 HTTPS Coze 源 `/internal/model-completion` 调用 SDK；必须核对项目 `7689833705046130729` 和 DEV／PROD 环境。请求使用 HMAC-SHA256，包含 method/path/timestamp/nonce/body SHA256，60 秒时间窗和有界重放防护。未授权请求统一 404；密钥仅留在两侧服务端。可用独立 `TIYU_LLM_BRIDGE_KEY`，或从已有 `TIYU_GATEWAY_KEY` 以固定域分离标签派生，不能把现有网关 Key 发给浏览器／APK。

Coze 端使用 `LLMClient.stream()` 聚合完整输出，保留真实 token 用量；`invoke()` 只返回内容，无法满足账本用量核验。答案为固定 `answer/explanation` JSON；无真实用量、明确非 stop 结束、无效结果和超预算均失败，后端释放预占，不扣平台点数。不返回 SDK 原始错误或凭据。

SDK 0.7.32 没有公开 `AbortSignal` 或供应商输出 token 上限参数：`maxOutputTokens` 是返回结果验收预算，不能硬限制平台生成；超时只停止交付，平台仍可能继续生成或内部重试并消耗资源。应用不自动重新发送。超时后台流保留并发占位，进程最多 4 个生成；模型目录最多 1 个读取任务、缓存 60 秒，目录读取期限 20 秒。平台资源费用与产品 1／2 点账本是两套规则，不能把平台费用承诺为固定金额。
