# M2管理员、短信注册、会员、点数、模型与公告合同 v1

M3.1 密码规则和短信找回以 [password-recovery-v1](password-recovery-v1.md) 为准：新密码 6–64 字符，旧长密码登录兼容；增加短信重设并撤销旧会话。下方旧密码长度说明仅为历史基线。

2026-09-27用户新增必须项，优先于cloud-v1中旧的普通用户名注册说明。既有个人导入、独立公共发布及账号隔离继续有效。基础token/session字段不删除。

## 手机号短信注册

用户已确定：注册填写手机号、短信验证码、密码和确认密码，成功直接登录；后续手机号+密码登录。一次性赠送10点AI额度和注册起15分钟全功能试用。

为兼容正在接线的基础接口，JSON username字段传规范手机号，UI显示“手机号”，principal额外返回phoneNumber/phoneVerified。首版接阿里云中国站国内短信，11位大陆号码规范为+86加11位，+86输入同样接受；其他国家号未配置相应短信通道时明确不支持，不误发。按规范号码唯一，不能客户端指定角色/注册时间/赠送点数。

- POST /v1/auth/registration-code：{username}，成功202 {challengeId,expiresAt,retryAfterSeconds:60}。错误503 SMS_NOT_CONFIGURED/SMS_UNAVAILABLE、429 RATE_LIMITED。验证码不在响应或日志出现。
- POST /v1/auth/register：{username,password,passwordConfirmation,verificationCode,challengeId,displayName?,clientId}。校验密码一致、强度和真实短信challenge成功后201返回完整session envelope并直接登录。
- POST /v1/auth/login保持{username,password,clientId}，UI为手机号登录。

验证码服务端安全随机6位，5分钟到期，单次使用；仅存HMAC摘要（独立环境密钥，不是可穷举裸SHA），绑定手机号、注册用途和challenge。手机号60秒冷却、每小时5次/每日10次，IP及全局短信预算另限流；最多5次错误尝试，换challenge不清手机号失败预算。短信发送超时不能无限自动重发。注册事务内消耗验证码、建唯一用户、赠送10点流水、发放一次trial及会话；并发注册不能重复赠送。

阿里云SendSms使用已审核签名/验证码模板、RAM最小发送权限和受控环境凭据；不在聊天/源码/日志存Secret。用户已具阿里云账户，签名/模板审核状态待答。生产未配置时禁用发送/注册，不能用万能码或日志验证码绕过；自动测试可注入只存在测试代码的SMS transport，生产入口不暴露fake开关。

## 用户与权限接口

GET /v1/admin/users?search=&membership=&disabled=&limit=50&cursor=... 返回items/nextCursor。条目字段userId、phoneNumber、phoneVerified、displayName、registeredAt、lastLoginAt（可null）、membership、membershipExpiresAt、trialStartedAt、trialEndsAt、disabled、pointsBalance、pointsReserved、pointsAvailable、revision。注册和成功登录更新lastLoginAt，refresh和/me不算重新登录。

全部admin路由由服务端查当前admin角色；普通用户不能改身份/点数/会员。以下变更都带Idempotency-Key并记审计：

| 路由 | 输入与行为 |
| --- | --- |
| POST /v1/admin/users/:id/membership | {membership,membershipExpiresAt?,expectedRevision,reason} |
| POST /v1/admin/users/:id/status | {disabled,expectedRevision,reason}，禁用同时撤销全部会话 |
| POST /v1/admin/users/:id/revoke-sessions | {reason}，强制退出全部客户端 |
| POST /v1/admin/users/:id/points-adjustments | {delta,expectedRevision,reason}，安全整数增减并留流水 |
| GET /v1/admin/users/:id/points-ledger | 分页流水 |
| GET /v1/me/points-ledger | 仅本人分页流水 |
| GET /v1/admin/audit | 分页操作者、动作、目标、时间、结果与脱敏变更摘要 |
| GET /v1/admin/releases | 发布历史，含releaseId、bankId、dataVersion、releaseSequence、title、state、sourceBankId、sourceDataVersion，供刷新后撤回 |

禁用后登录、更新、下载、AI立即服务端拒绝；启用不恢复旧token。禁止自我封禁及封禁最后一个可用管理员。本人/管理员查看题库沿cloud-v1，管理员日常手机检索不自动获得所有私库。

## 会员、试用与功能许可

membership为free或sponsor，membershipExpiresAt=null表示长期赞助；到期按free。trialStartedAt=注册时间，trialEndsAt=注册时间+15分钟，重登/换手机/重装/改会员不重置。admin角色与会员分开；CLI引导管理员可明确赋sponsor，客户端不能靠role绕过。

| 能力 | free试用中 | free试用结束 | 有效sponsor |
| --- | --- | --- | --- |
| 登录、个人导入/管理、更新下载 | 可用 | 可用 | 可用 |
| 悬浮窗、截图识别查题、手动查答案、自动复制 | 可用 | 禁用 | 可用 |
| AI调用 | 有点数且模型可用 | 禁用 | 有点数且模型可用 |

本地检索不扣AI点数。初始10点不随15分钟试用到期删除，但free到期无AI权限；以后转sponsor可继续使用余额。管理员查看题目/答案属于管理能力。手机号真实验证、注册限流与试用点数预算共同限制滥用，不凭手机号格式通过即宣称已防重复试用。

注册/登录/refresh及GET /v1/me响应增加account对象：

```json
{"membership":"free","membershipExpiresAt":null,"trialStartedAt":"ISO UTC","trialEndsAt":"ISO UTC","pointsBalance":10,"pointsReserved":0,"pointsAvailable":10,"revision":1,"entitlements":{"floatingAllowed":true,"aiAllowed":false,"reason":"trial","validUntil":"ISO UTC"}}
```

reason=trial/sponsor/free_expired/sponsor_expired/disabled。aiAllowed还需足够点数与启用模型，每次服务端调用重新校验。

身份离线7天与悬浮窗许可分开：功能许可validUntil最多服务端now+15分钟，同时不超过trialEndsAt或membershipExpiresAt及会话期限。运行浮窗后台每60秒/me续验，启动/回前台也验；题目仍手机本地检索，不逐题联网。断网可用到当前许可到期，随后停截图服务、隐藏浮窗、清答案/候选并提示联网。试用绝不超trialEndsAt。可信serverTime+elapsedRealtime计算，重启或无法确定时联网，改系统时间不能延长。

在线收到降级/封禁立即停用；离线无法即时感知，最多已有15分钟许可期限。AccountQuestionBank查询也核功能许可，导入/更新只需要有效账号。UI、截图、手工、候选/复制都检查，正常产品入口不能通过demo模式绕过会员。题库session provider增加独立query能力回调，不把free账号等同失效。

## 点数与调用流水

使用安全整数，禁止负余额/越界/浮点误差。pointsBalance=总余额，pointsReserved=在途预留，pointsAvailable=余额-预留。每次加减事务内记不可变流水（用户、delta、前后值、原因、操作者/AI请求ID、时间、幂等键）；管理员输入目标余额也转换为带revision的差额，不能扣掉已预留额度。纠错通过反向流水，不能删除旧记录。

首次注册10点赠送仅一条唯一流水。模型真实接入采用服务端校验权限/余额→原子预留→调用→成功结算、明确失败退回；幂等防重复扣点，超时或重启不盲目重试收费请求，待核对状态必须有恢复/审计处理。

首期模型收费支持fixed_per_call，pointsPerCall正整数，调用前显示点数成本；不声称与供应商金额/token一比一。记录usage与请求ID方便以后token计费。用户原话“后续接入模型”，本轮先实现管理配置/测试与账本；具体用户AI用途/入口未冻结时不偷偷把每次本地查题上传模型或扣点。

## 模型配置与真实测试

GET/POST /v1/admin/models、PATCH /v1/admin/models/:id（expectedRevision）管理配置。字段provider(deepseek/doubao)、displayName、modelId、baseUrl、apiKey（只写）、enabled、capabilities、maxOutputTokens、timeoutMs、dailyRequestLimit、pointsPerCall、revision、keyConfigured/keyFingerprint、lastTestAt/lastTestStatus/lastTestErrorCode。Key空白表示保留，明确removeKey=true才清除；返回永不含明文Key。

Key用独立环境主密钥AES-GCM加密，缺主密钥拒绝保存；主密钥不与数据库一同公开，备份/轮换分开处理。网页只本次表单内存，提交后清空。日志、API列表、静态文件和APK不能含密钥。

本轮只开放已核对官方HTTPS源：https://api.deepseek.com，以及https://ark.cn-beijing.volces.com/api/v3。固定追加/chat/completions，拒绝任意URL/IP/userinfo/query/redirect，系统TLS校验。其他地区/供应商以后扩白名单。modelId需真实模型ID或豆包ep接入点，能力不能凭名字推断；更改Key/modelId/baseUrl/能力使旧测试失效，验证前不可启用。

POST /v1/admin/models/:id/test {expectedRevision}+Idempotency-Key发送固定非私人测试文字、小输出上限，验证非空结果及usage、记录延迟/脱敏失败原因。按钮明确小额供应商测试调用，不扣普通用户点数。空内容/截断、鉴权失败、模型权限、余额不足、限流、网络错误分别显示；/models列表或保存成功不能冒充推理测试通过。无Key时只能记录未配置和测试适配器验证，不能写实网已通过。

## 公告

GET/POST /v1/admin/announcements、PATCH /v1/admin/announcements/:id（expectedVersion）。字段id/title/body/version/status(draft/published/withdrawn)/audience(all/free/sponsor)/publishedAt/startsAt?/endsAt?，发布/实质编辑递增version且审计，正文纯文本防脚本执行。

GET /v1/announcements返回当前适用已发布公告，默认过滤dismiss的版本，可includeDismissed=true用于历史入口；POST /v1/announcements/:id/dismiss {version}按user+id+version幂等记录。App登录/回前台/正常同步拉取，“不再提醒”离线先保存，原账号联网再同步；origin+user隔离，不能替换号后的用户标已读。新版本可再提醒，撤回或过期不弹。

## 补充和验收

本轮加入操作日志、点数流水、会员到期、强制退出、备份恢复说明及模型限额。后续建议：短信找回密码、管理员二次验证、支付与退款、申诉反馈、导入失败重试看板；不擅自接入实际支付交易。

验收包括短信错误/过期/重放/并发注册/唯一10点；用户伪造会员点数失败；试用15分钟/改钟/重装无续期；sponsor到期、free停用、封禁会话、并发余额和幂等；Key不泄露/变更使测试失效；公告dismiss换号/版本隔离。生产短信、模型验证需实际配置，不用假结果代替。

依据：[阿里云SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)、[短信使用条件](https://help.aliyun.com/zh/sms/user-guide/usage-notes)、[DeepSeek](https://api-docs.deepseek.com/guides/harness)、[豆包](https://docs.volcengine.com/docs/ark/chat-api?lang=en)。
# M3补充：可选 Supabase 手机号证明

2026-09-27用户提供Coze/Supabase OTP示例，并要求最终公网部署与真实短信验证。原注册UI及v1字段继续为手机号、验证码、密码、确认密码，成功直接返回题屿会话。示例中的纯验证码登录和`x-session`不是本产品契约变更。

- 服务端可选择原本地验证码+Aliyun发送，或`SMS_PROVIDER=supabase`。Supabase项目URL和publishable/anon key必须来自可验证的实际项目配置；固定HTTPS源，拒绝重定向、自动重试与客户端任意源。生产缺配置明确`SMS_NOT_CONFIGURED`。
- Supabase模式由上游生成验证码；服务端用官方SDK `signInWithOtp` / `verifyOtp`，再用返回的access token调用`getUser`核对固定项目、已确认手机号和subject。上游凭据仅此次验证内存，不传客户端、不落日志，不使用上游metadata授予管理员。
- 本地挑战绑定provider、issuer、手机号和注册目的，最长5分钟，上游更短有效期优先；服务端持久化发送预算、冷却与跨挑战失败次数。原子claim防并发验证，切换provider/issuer拒绝旧挑战。网络不确定或重启残留须重新取码，不能自动重放可能计费请求。
- 题屿密码继续本服务scrypt保存，不给上游设置密码。注册事务同时消费当前证明、绑定唯一(issuer,subject)、创建唯一手机号用户、赠送一次10点、开启一次15分钟试用及签发本地会话。已有手机号不得自动重绑或覆盖密码。上游验证成功而本地提交失败要求新码，不缓存可重复使用的电话证明。
- SQLite迁移至schema4保存外部身份绑定和挑战状态；M2 schema3备份保留。此模式仅是可配置适配器，合成SDK/HTTP测试不代表Coze已开放端点、已启用短信或验证码已真实送达。
