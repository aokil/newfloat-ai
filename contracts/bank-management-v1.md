# M5 题库浏览与个人题目维护 v1

2026-09-27，主控冻结。补充cloud-v1和本地账号库接口，不替代题型、身份、发布或原子同步规则。

## 权限与版本

- 登录且会话有效的用户可浏览本人私库及已发布公共库，管理本人私库；此权限不要求悬浮窗会员许可。截图/检索继续走独立canQuery门禁。
- 普通详情接口不开放他人私库；管理员查看他人私库仍走已有独立审核接口。新增/编辑仅本人私库允许，管理员角色不自动扩大写权限。公共库只读。
- 每次新增/编辑生成新的不可变私人dataVersion及递增releaseSequence，记录审计；已发布公共快照不变，须重新审核并明确发布才向其他用户下发。
- 写操作使用expectedBankVersion及Idempotency-Key。版本不符409/VERSION_CONFLICT，保留用户输入，不自动覆盖；不匹配当前账号范围的bankId/questionId返回404。相同幂等键重试不能重复新增。

## HTTP

保留既有GET语义，新增字段可向后兼容。所有响应继承认证/no-store/同源规则。

| 方法 | 请求 | 响应增量 |
| --- | --- | --- |
| GET /v1/banks/:id | 可选dataVersion | 现有目录项增加typeCounts |
| GET /v1/banks/:id/questions | offset默认0、limit默认50范围1–200；可选questionType、dataVersion、view=index | {bankId,dataVersion,items,total,bankTotal,offset,nextOffset} |
| GET /v1/banks/:id/questions/:questionId | 可选dataVersion | {bankId,dataVersion,item} |
| POST /v1/banks/:id/questions | {expectedBankVersion,question}及Idempotency-Key | {bankId,dataVersion,releaseSequence,questionCount,item} |
| PATCH /v1/banks/:id/questions/:questionId | 同上 | 同上 |
| PATCH /v1/banks/:id | 本人私人题库，`{expectedBankVersion,title,description}` 及 `Idempotency-Key`；名称1–200字、简介0–1000字 | `{bankId,dataVersion,title,description,unchanged}` |
| DELETE /v1/banks/:id | 本人私人题库，`{expectedBankVersion}` 及 `Idempotency-Key` | `{bankId,status:"deleted"}` |

私人题库删除由服务端核对本人身份和当前版本，在一个事务内删除上传原件、所有私人快照及未发布的审核记录；已发布的公共快照是独立且不可变的，保留公开版本与审核引用，源私人题库只保留不可见的关系占位。私人清单和管理员待审列表均不再返回被删题库；安卓在云端成功后清理本机导入原件并同步本机索引。云端成功但本机同步失败须明确提示待同步，不能声称两端都已删除。

目录和清单中的私人项可增加 `importedAt`（Unix 毫秒），用于展示真实的 `yyyy-MM-dd` 导入日期；旧服务没有该字段时，安卓可用同账号本机导入记录时间回退，仍取不到时显示待同步，不合成日期。

私人题库名称和简介编辑生成新的不可变私人版本，原题目内容与顺序不变，题目内部的dataVersion同步替换；云端提交成功后安卓更新本机清单，失败保留旧版并提示。已发布的公共版本不随私人简介编辑变化。安卓收藏与笔记当前只按账号保存在本机，页面明确标注，不宣称云端同步。

typeCounts固定包含single_choice、multiple_choice、true_false、fill_blank、short_answer、unknown六个键，空组为0。total为当前过滤组题数，bankTotal为全库题数；nextOffset到末页为null。dataVersion指定时必须与当前可用快照一致，否则409，不能混用新旧页。

完整item沿question-types-v1，附加ordinal与groupOrdinal：ordinal为当前版本原始全库顺序的1-based序号，groupOrdinal为该题型内的1-based位置。questionId为稳定身份；题号不是身份。新增附加在原始全库顺序末尾，编辑保留全库位置；变更题型后重算组内位置。

view=index时items只含questionId、questionType、ordinal、groupOrdinal、answerComplete；省略view时仍返回完整题目兼容旧客户端。GET单题与写响应的item为完整题目。

写入question只接受既有EDIT_FIELDS，禁止客户端设置bankId/owner/version/ordinal等服务字段。新增由服务器生成questionId，请求不得自带questionId；修改可省略questionId，携带时须与路径一致。复用题型结构及答案完整性校验，不凭勾选完整强行补答案。本轮不增加删题、批量操作或公共内容直接编辑。

## Android共享库

在AccountQuestionBank增加以下同步入口，宿主必须在后台线程调用：

```kotlin
fun getBank(bankId: String, expectedDataVersion: String? = null,
    signal: CancellationSignal = CancellationSignal()): JSONObject
fun listQuestions(bankId: String, questionType: String? = null,
    offset: Int = 0, limit: Int = 50, expectedDataVersion: String? = null,
    signal: CancellationSignal = CancellationSignal()): JSONObject
fun getQuestion(bankId: String, questionId: String, expectedDataVersion: String? = null,
    signal: CancellationSignal = CancellationSignal()): JSONObject
```

成功响应与对应HTTP形状一致并添加status="ok"及既有可信会话stamp；listQuestions固定返回轻量索引。失败用status：not_found/invalid_request/not_ready/unauthorized/conflict/cancelled/timeout/error/unavailable，包含可读message，不泄露其他账号内容。

浏览操作检查可信会话、取消、快照读锁和返回前代次，不调用canQuery会员门禁。固定版本内顺序稳定，数据库持久化ordinal；旧库迁移保留账户与题库内容。schema1未保存原序，先对q_数字使用自然序、其他ID稳定排序作临时离线序，并标记needsOrdinalResync；不能声称恢复任意原始顺序。下一次认证同步对这类库强制下载当前快照，全部成功后原子替换并清标记；失败保留旧数据。schema2后同步复用未变题库也须保留ordinal原序。

写操作由宿主通过现有SessionManager执行上述HTTP；云端提交成功后执行现有完整清单update与原子索引切换，不在宿主直接写共享SQLite。云端成功而本机同步失败时显示“已保存到云端，本机待更新”，保留旧可用快照，不重放新增请求。待更新状态绑定当前源/账号，换号不显示上一账号内容。

## 浏览与恢复

按固定六种题型顺序分组，每次只展开一组、每页50个题号。单题上一/下一按该分组序列前后移动，跨组进入下一非空组；首末禁用，不循环。页面通过questionId定位，保存bankId/dataVersion/题型/分页与滚动位置；改题型或版本变化后重新读计数，使用groupOrdinal定位新页。

## 导入结果

文档解析须识别被支持的数字题号、章节题型、选项、明确答案与Word自动编号。可靠章节数量与解析数量不符、疑似多题合并或结构缺损时明确诊断并阻断错误确认；合法单题文件不因只有1题而拒绝。保留原件，原文中的指令只作为待解析内容。

摘要区分候选题数、待核对题数（候选的子集）、结构错误数、入库题数与本机同步状态。已有错误私库不得在升级或启动时自动删除或被后台重导覆盖。用用户提供DOCX本地复验，同时提交不含用户全文的合成回归；公共发布必须继续由管理员明确完成。

导入info/list摘要增加reviewQuestionCount，为errors非空或answerComplete不为true的候选题数量；errorCount保留原有结构错误条数语义。解析与每次预览纠错后重新统计，前端不以首50条推算总量。failed/processing/无候选/结构错误仍存在时禁止确认。

原文缺少某个选项但现存字段仍可合法表达时，保留已有选项和来源答案证据，以answerComplete=false及明确来源说明标记待核对；不得补造内容，也不因标签不连续直接阻断整库。答案引用不存在选项、多题合并、相互冲突等仍须结构纠错。判断题答案A/B可按对应选项的“正确/错误”文字转换布尔值，不猜测未知选项含义。
