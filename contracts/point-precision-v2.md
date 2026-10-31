# 小数点数与新模型协议（2026-10-30，仅源码）

本次只改源码并运行用户授权的本机合成测试，不构建 App、不部署、不改生产数据。此前发布 v73 保持。普通可选更新，不提高最低联网版本。

## 用户确认

| 产品 key | 实际模型 ID | 每次成功解题 |
| --- | --- | --- |
| baichuan-air | Baichuan4-Air | 0.2 点 |
| deepseek-flash | deepseek-flash | 0.5 点 |
| deepseek-pro | deepseek-v4-pro | 2 点 |

- 百川为一个品牌组，分“通用快速”和“医学推理”，共用说明。4-Air 说明“通用快速模型，正确率有待考量”；M2/M3 维持 1/2 点、医学说明及固定预算。
- 2026-10-31 用户最新映射覆盖先前选择：App内置DeepSeek与型号同一行提供思考菜单，向上展开并直接选择，按账号保存。**Light＝关闭思考，Medium＝官方low，High＝官方high**，默认Light；不展示max。菜单及启用反馈提示可能等待更久，替代原独立开关/二次确认；按用户后续要求不在该界面显示token预算说明，实际预算规则如下。
- Medium/High 发送 `thinking:{type:"enabled"}`、对应 `reasoning_effort:"low"/"high"`，固定 `max_tokens:4096`；Light 发送 disabled，短答案沿既有预算且不超过2048。4096是思考和最终答案合计上限，不是保证产出答案。预算用尽、无完整答案、无完整用量时失败释放平台预占，不自动重试；供应商仍可能计费。
- 沿原只给答案提示词、完整答案和成功回执后展示、非流式。DeepSeek 原自带 Key 入口保留，档位仅作用于新增两个内置型号。导题批次和未完成请求锁定档位，查回执不会重新调用；旧Boolean偏好false迁移为Light、true迁移为High，旧未完成请求保持Boolean-only摘要。
- `POST /v1/ai/search` 为内置DeepSeek接受可选 `reasoningEffort:"low"|"high"`；指定时隐含开启，不能与 `thinking:false` 混用。其他模型/用途或其他值返回400；强度加入请求摘要，复用幂等key改变强度返回409。旧 `thinking:true` 且未传强度默认high、保留旧摘要；完成回执的model可包含实际reasoningEffort。
- 4-Air、M2/M3、Pro 强制无图片能力；Flash 按官方精确 ID 支持图片，沿原框选图片、能力校验和大小限制。百川保持图片开关状态并阻止调用。AI OCR 成功的独立 1 点不变。

## 精度及接口协商

- 账户、账本和回执里的点数含义不缩放，100 点始终为 100 点。算术以 1/100 点整数执行，最多两位小数；可用余额精确减预占，不能超支，失败释放、幂等及会话复核沿原规则。
- 新 App/网页发送 `X-Float-Points-Precision: 2`，网关允许透传。响应金额字段保留精确十进制数，并在同一对象增加 `<field>Units` 整数及 `pointsUnitScale:100`。例如 `pointsAvailable:0.5, pointsAvailableUnits:50`。客户端优先读取并核对最小单位，显示不补多余的零。
- 覆盖账号/登录/刷新、目录价格、AI/OCR及支付回执、管理员调点、明细；人民币分、充值套餐整点数、赠点活动及版本门槛不变。
- 无该头为旧版兼容：金额只返回整数部分；目录不返回 0.2/0.5 档位；直接调用小数型号或提交小数调整返回 426/`POINTS_PRECISION_REQUIRED`，在预占前拒绝。整数模型仍按真实余额结算并保留小数。
- 旧版可能显示 0 点而账户实际尚有不足 1 点，旧版基础功能可能因此要求更新。旧明细解析器不能接受小数或零变动；所查询类别存在小数流水时返回明确的“请升级查看完整明细”提示，服务端完整保留真实余额和流水，新版明细完整显示。用户已于 2026-10-31 确认允许此提示；整体仍为普通可选更新，本轮未发布。
- 没有全局强制更新，不抬高最低联网版本。新旧端都不能用展示值反向覆盖服务端余额。

## 服务端密钥及管理

- 百川所有内置型号仅读取服务端 `BAICHUAN_API_KEY`；新增 DeepSeek 两型号仅读取 `DEEPSEEK_API_KEY`。均为固定官方来源，不提供客户端 Key 输入、不写数据库密钥列、不进入 APK/网页资源。
- 管理表单按目录 metadata 绑定精确模型 ID 和价格，不能用展示名猜型号；环境变量变更会使旧测试指纹失效，须重新测试并启用。配置成功不等于已经真实验证可用。
- 内置配置的maxOutputTokens=2048仍为基础短答预算；DeepSeek开启思考时由服务端固定4096策略覆盖，不新增数据库字段、迁移或由客户端指定任意token上限。管理表单明确显示两种预算含义，百川预算保持原规则。
- 下次部署需一并更新本地 Coze 仓库中的后台模块、网关与运行环境身份指纹，不只更新 App。本轮没有配置真实 Key 或发送付费请求。

## 数据库 schema 11

- PostgreSQL 将 `users.points_balance/points_reserved`、`points_ledger.delta/balance_before/balance_after`、`ai_requests.points_cost` 改为 `NUMERIC(18,2)`，保存原金额，不乘 100。其他 ID、时间、版本、支付人民币分和套餐列不变。SQLite 用整数最小单位计算及保留两位的预占更新，原整数亲和列容纳实际小数。
- 初始化迁移位于事务内。存在未过期 pending AI 请求则以 `POINTS_PRECISION_MIGRATION_BUSY` 拒绝；只释放已过期请求且验证预占，释放标记 PROCESS_INTERRUPTED；异常精度/范围或结构直接拒绝并回滚。
- 旧 8/9/10 及平台预复制的完整 11 结构均需原完整结构验证；非空无版本标记不自动收编。表缺失、部分精度转换不假装成功。
- 后续上线前：备份数据库，先停止旧服务新请求并等进行中请求结束，在隔离 PostgreSQL 验证迁移、回执和新旧接口，迁移后再开新型号。不能让旧后台进程继续改已出现小数的账本；也不能把 NUMERIC 改回 BIGINT 或恢复旧代码来“回滚”小数余额。
- 本轮仅 SQLite 真正执行迁移/回滚，PostgreSQL 只做 mock adapter 及 SQL 合同验证；未运行实际 PostgreSQL 迁移，更未触碰 Coze 生产库。

## 已核对官方文档

- [DeepSeek 模型概览与能力](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- [DeepSeek 对话接口、thinking、reasoning_effort、max_tokens](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- [百川 API 文档](https://platform.baichuan-ai.com/docs/api)

源码测试与边界见 `docs/validation/air-deepseek-point-precision-source-2026-10-30.md`。
