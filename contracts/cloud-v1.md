# M2 统一账号、个人导入与题库同步 HTTP 合同 v1

2026-09-27，主控实施基线。用户明确要求接通正式登录、个人导入、云端更新服务。单 APK 不变；M1包/证据冻结，demo路径保留但不能承载真实个人数据。公网部署依赖用户提供/选定的环境，localhost联调不得叫已接通云端。

手机号短信注册、自动登录、初始10点、15分钟试用、会员、模型配置、公告及管理员操作以新增 [admin-v1](admin-v1.md) 为准，覆盖下文旧的普通用户名注册描述；基础token/session字段保持兼容。身份离线缓存不等于悬浮窗功能许可。

## 共同规则

API前缀 /v1。生产仅HTTPS，客户端验证系统信任证书、不使用trust-all；开发仅明确启用的loopback HTTP，使用合成测试账号。服务baseUrl可配置，换源视同退出并隔离数据库；凭据绝不能跨源转发。后端单实例持久化SQLite WAL起步，不宣称多实例水平扩容；为迁移/备份与分包留边界。

JSON UTF-8；错误 {error:{code,message,requestId,retryable}}。400 INVALID_REQUEST、401 INVALID_CREDENTIALS/ACCESS_EXPIRED/SESSION_REVOKED/REFRESH_EXPIRED/REFRESH_REUSED、403 FORBIDDEN/ACCOUNT_DISABLED、404 NOT_FOUND、409 VERSION_CONFLICT/IDEMPOTENCY_CONFLICT、413 TOO_LARGE、415 UNSUPPORTED_FORMAT、422 VALIDATION_FAILED、429 RATE_LIMITED、503 UNAVAILABLE。不将服务失败解释成清空题库或无需更新。

Android及网页的认证使用 Authorization: Bearer <accessToken>，不把token放URL。网页首版不把token存localStorage（可仅内存会话，刷新页面需重新登录）；不启用通配跨域，不通过GET执行写操作，用户内容作为文本渲染。日志不记录密码/令牌/私人文件正文，认证响应Cache-Control:no-store。请求schema拒绝未声明角色/owner等赋权字段。

写操作的 Idempotency-Key 为1–128字符、按userId/路径绑定，保存请求摘要；同键同内容返回原结果，同键异内容409。至少覆盖文件上传、导入确认、公共发布/撤回。refresh明确不幂等，响应丢失且无法确认新令牌时重新登录。

## 账号与会话

注册默认普通用户，无首位注册自动管理员，无固定管理员密码。管理员通过服务器CLI受控初始化/授予，生产账号凭据不写仓库或日志。

| 方法与路径 | 输入 | 成功 |
| --- | --- | --- |
| POST /v1/auth/register | {username,password,displayName?,clientId} | 201，会话信封 |
| POST /v1/auth/login | {username,password,clientId} | 200，会话信封 |
| POST /v1/auth/refresh | {refreshToken,clientId} | 200，新会话信封/轮换令牌 |
| GET /v1/me | access | 200，principal、session、serverTime、offlineUntil |
| POST /v1/auth/logout | access或body {refreshToken,clientId}，二者择一 | 204，撤销本会话家族 |
| POST /v1/auth/change-password | access + {currentPassword,newPassword} | 204，撤销全部会话，客户端重新登录 |

clientId固定 android 或 web，仅用途标签，不是客户端秘密。username规范化、3–64字符，允许字母/数字/._@-（含Unicode字母数字），不允许空白；服务端唯一且规范化规则一致。password不trim、不改写，注册/改密12–128字符；登录限制输入预算但兼容已有合法值。错误登录统一文案，按来源和登录名限流；未知用户仍作同成本密码校验。建议异步scrypt N=131072/r=8/p=1/maxmem至少192MiB、独立随机盐，限制并发和排队；依赖与具体实现须审查验证。

会话信封：

```json
{
  "principal":{"userId":"u_uuid","username":"example","displayName":"用户","roles":["user"]},
  "session":{"sessionId":"s_uuid","clientId":"android"},
  "tokenType":"Bearer",
  "accessToken":"<opaque random token>",
  "accessExpiresAt":"2026-09-27T03:15:00.000Z",
  "refreshToken":"<rotating opaque random token>",
  "refreshExpiresAt":"2026-10-27T03:00:00.000Z",
  "offlineUntil":"2026-10-04T03:00:00.000Z",
  "serverTime":"2026-09-27T03:00:00.000Z"
}
```

实际时间由服务端生成，示例不是默认配置。access 15分钟，会话绝对有效期30天，refresh一次性轮换/复用撤销当前家族。服务端逐请求核对用户状态、会话和当前角色；只存令牌SHA-256摘要。HTTP过期访问可以single-flight刷新后安全重试一次；变更请求仅带幂等键时重试。

Android将令牌及身份元数据一起用Keystore保护；本机只信任HTTPS已验证响应生成的会话，不信任输入的userId/role。离线授权至最近成功服务验证后的7天且不超过会话期限；通过时间回拨不能延长，无法确认期限时需联网。退出立即清当前身份/答案/候选、取消请求；保留按原账号隔离的待同步文件，不上传给新账号。云端明确401撤销/403封禁不能当作断网继续离线。断网不能保证即时获知云端撤销。

## 导入、校验与确认

手机SAF与网页都上传本人选择的文件，归属从会话取得，不接受ownerUserId。上传原件保存在非公开目录，管理员可通过有鉴权的管理入口查看；不因只上传原件就称已成功入库。离线移动端将文件/任务留在按服务源及userId隔离的本地待同步队列，联网恢复后再同步。

| 方法与路径 | 输入/用途 | 成功 |
| --- | --- | --- |
| POST /v1/imports | multipart单file、可选title，Idempotency-Key | 202 {importId,status,revision,filename} |
| GET /v1/imports?limit=50&cursor=... | 本人的任务列表 | {items,nextCursor} |
| GET /v1/imports/:id | 任务状态 | {importId,status,revision,filename,format,title,questionCount,errorCount,warnings,errors,bankId?,dataVersion?} |
| GET /v1/imports/:id/questions?offset=0&limit=50 | 分页预览 | {items,total,revision} |
| PATCH /v1/imports/:id/questions/:questionId | {expectedRevision,question:{...可编辑内容}} | 更新项及新revision |
| POST /v1/imports/:id/confirm | {expectedRevision,title?,bankId?,expectedBankVersion?} + Idempotency-Key | {bankId,dataVersion,visibility:"private",questionCount} |
| GET /v1/imports/:id/source | 本人原文件下载 | 原始字节，安全Content-Disposition |

任务状态 uploaded/processing/needs_review/ready/failed/confirmed。解析结果必须经过用户确认，不自动生成缺失答案；不完整可保留但不能伪造answerComplete=true。无有效题或存在结构错误时确认422，并提供具体项；可人工纠错后再确认。每次编辑递增revision，过期确认409，防止预览与实际提交不一致。

题目编辑字段：questionType、stem、options[{id,text}]、answerText、answerOptionIds、answerBoolean?、answerParts?、expectedBlankCount?、answerComplete、explanation、sourceName。含questionId用于定位，bankId/dataVersion/owner等由服务端赋值，不可编辑。所有结构与question-types-v1一致，完整性由实际结构再校验，复用A/B选项映射；未知类型/incomplete不能自动复制。正文、段落、来源页码及图片/公式原件引用保留，不把仅提取文本当成正确拆题。

支持格式按 docs/import-scope.md 逐项落地。M2至少真实完成CSV/TSV/JSON/JSONL/TXT与XLSX/DOCX/文本PDF的规则版式导入；其他适配器及复杂版式明确状态，不宣称全部主流格式已经完成。上传/解压/页数/单题/时长均有限额，拒绝危险解包路径、实体扩展、执行宏/脚本、解析时外链抓取，预算是单任务资源约束而非产品题数上限。具体配额与已测格式在适配器文档公布。

确认建立private不可变版本并自动成为本人同步清单的一部分。确认个人导入≠公共发布。重试不能多建同一题库。后续修改/新版本仍private，需要重新管理员审核才影响公共通道。

缺省不传bankId时创建新私库。可选择以此次导入替换本人的某个私库：同时传bankId与expectedBankVersion，事务内核对该库归属与当前版本，产生新dataVersion并递增sequence；他人库404、版本变化409。管理员也不能借普通确认接口覆盖他人私库。缺少expectedBankVersion不能盲覆盖。旧私库版本仅供审计/审核记录，普通同步只下发当前版本；已经公开的独立快照保持原内容。

## 本人题库与管理员发布

GET /v1/banks 返回 {items:[{bankId,title,visibility,ownerUserId?,dataVersion,releaseSequence,questionCount}],nextCursor}，普通查询范围始终本人私库+已发布公共库。GET /v1/banks/:id及 /questions 使用同一范围；知道ID不构成授权。他人私库路由返回404避免泄漏。

管理员走明确路由（服务端校验admin并审计，不只隐藏按钮）：

| 方法与路径 | 行为 |
| --- | --- |
| GET /v1/admin/imports | 分页查看所有已同步导入，含ownerUserId |
| GET /v1/admin/imports/:id | 管理任务状态/来源信息 |
| GET /v1/admin/imports/:id/source | 鉴权查看原件 |
| GET /v1/admin/banks | 所有私人题库与当前版本供审核 |
| GET /v1/admin/banks/:id/questions | 明确dataVersion的分页内容 |
| POST /v1/admin/banks/:id/reviews | {dataVersion,decision:"approved"或"rejected",comment?} → {reviewId,...} |
| POST /v1/admin/banks/:id/releases | {dataVersion,reviewId} + Idempotency-Key，事务校验审核与当前源版本 → 公共快照 |
| POST /v1/admin/releases/:releaseId/withdraw | Idempotency-Key，撤回公共发布供客户端下一次同步删除 |

发布产生独立public bankId及独立dataVersion/releaseSequence，保留来源私库版本仅用于内部审计；不将owner身份和私人存储路径放公共包。公共快照不可被作者后续私改覆盖。撤回/删除通过完整清单的消失语义应用，离线设备下一次成功同步才获知。管理员普通本地查询不自动下载其他人的私库。

## 完整同步清单与数据包 v2

GET /v1/sync/manifest（必须access）返回当前用户完整授权清单，不得分页截断却声明complete=true：

```json
{
  "manifestVersion":2,
  "normalizationVersion":"text-v1",
  "subjectUserId":"u_uuid",
  "catalogRevision":"opaque-current-catalog-hash",
  "complete":true,
  "generatedAt":"2026-09-27T03:00:00.000Z",
  "banks":[{
    "bankId":"b_uuid","title":"我的题库","visibility":"private","ownerUserId":"u_uuid",
    "dataVersion":"v_uuid","releaseSequence":1,"questionCount":100,
    "package":{"format":"question-bank-json-v2","path":"/v1/sync/packages/p_uuid","sha256":"<64 hex>","sizeBytes":12345}
  }]
}
```

public条目的ownerUserId为null。包路由GET /v1/sync/packages/:id逐请求核对本人私库/仍发布公共快照权限，不是可分享的永久裸链接；不跨源重定向。包UTF-8 JSON：{schemaVersion:2,normalizationVersion,bankId,title,visibility,ownerUserId,dataVersion,releaseSequence,questions:[...]}，题目内容字段沿用typed合同，并含正确bankId/dataVersion；填空来源证据为expectedBlankCount。Question主键和grams关联必须按(bankId,questionId)区分，公共/私人复制不能互相覆盖。

客户端先认证并检查subjectUserId、complete、源、版本及预算；下载变化包，核对实际字节/SHA256、题数、结构、所有权和版本单调性，建立索引。全部必要包成功后原子提交完整清单及删去该账户本地已不在清单的库，不能下载一半就删旧库。一个查询固定快照；离线失败/401/取消/校验失败不清空数据。只比较部分清单不能判up_to_date。首次空完整清单是合法无题库，demo数据不混入正式库。

本轮可全量快照，分包/增量后续迭代；每次清单有处理预算，超预算明确失败，不静默截断。更新结果沿M1状态语义并反映实际banks；updated必须落库成功，up_to_date必须比对真实完整清单。服务器与用户身份发生改变时作废在途下载和旧响应。

## Android库与宿主边界

题库任务在local-bank新增账号版入口，复用core匹配，不改M1冻结产物。实例按规范服务源+可信userId隔离数据库，绑定sessionEpoch与有效性回调，每次查询/同步阶段和返回前检查，close取消在途操作。宿主负责Keystore会话/HTTP认证与刷新、SAF文件队列、界面；库负责结构校验/存储/索引/原子同步。精确Kotlin签名由双方直接对齐后追加本合同，不能各自复制查询算法。

已对齐的身份注入接口位于AccountInterfaces.kt：AccountIdentity(serverOrigin,userId,sessionId,generation,offlineUntilEpochMs)；AccountSessionProvider.current()/isCurrent(identity)/canQuery(identity)，后者独立核会员/试用许可，free仍可管理更新。AccountUpdateSource.fetchManifest(identity,signal):JSONObject及openSnapshot(identity,entry,signal):InputStream，流由库关闭。AccountQuestionBank(context,sessionProvider,updateSource?=null)提供initialize/getStatus/query/update/invalidateSession/close同步worker接口。所有状态/响应携带本次身份stamp，宿主拒绝过期返回；精确函数参数以双方编译通过的共享源码为准。

## 本轮验收

真正可运行的后端和App，不是仅设计或假登录。合成账号A/B/admin验证：注册登录刷新退出/改密；A导入纠错确认后本人云端和本地可查，B不可看；管理员可审阅但未发布时B清单不变；发布后B下载、离线查询；私改不影响公共已发布内容；撤回后下次同步删除；换号/换源/并发/取消无串号。网页手机电脑均可导入及管理员操作。保留原题型/答案与透明浮窗行为。

提交构建测试日志、格式支持证据、部署/初始化/备份说明和新增APK（versionCode>5）。公网正式部署须使用用户目标及HTTPS，未部署时明确最后缺哪项，不能把本机端口转发称云服务上线。

技术依据：[Fastify校验](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[官方multipart插件](https://github.com/fastify/fastify-multipart)、[OWASP密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。具体代码验证和部署证据另存，不以文档引用替代实测。
