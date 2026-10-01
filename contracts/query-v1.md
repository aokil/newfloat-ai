# 本机查询合同 v1：第一阶段原型基线

日期：2026-09-27。主控维护。本文安装身份/AIDL为冻结双 App 原型历史合同，当前单 App 实施以 local-bank-v1.md 为准；以下请求/响应业务字段和内容处理规则继续复用。产品架构见 docs/architecture.md。

新增账号需求见 docs/accounts-and-publication.md。当前 v1 为 P1 演示查询基线，未包含生产会话鉴权，不可用于接入真实私人题库。

## 通信与安装身份

- 题库 applicationId：com.newfloat.questionbank。
- 悬浮窗 applicationId：com.newfloat.floating。
- 服务组件：com.newfloat.questionbank/com.newfloat.questionbank.ipc.QuestionBankService。
- 服务 exported=true，使用签名级权限 com.newfloat.questionbank.permission.QUERY；悬浮窗声明 uses-permission 和题库 package queries。
- 同机原型使用同一开发环境的默认 Android debug 签名；发布签名后续统一规划，不能取消调用权限检查来绕过签名问题。
- 客户端显式绑定，使用 BIND_AUTO_CREATE；连接异步完成。不要调用启动题库 Activity 来代替本机服务连接。
- 两个工程直接引用 contracts/aidl/ 下的 AIDL 源文件，由各自构建系统生成接口。
- 服务查询方法异步回调；耗时数据库操作在后台执行。取消和进程断开后，客户端丢弃不再有效的响应。

## 请求 JSON

```json
{
  "protocolVersion": 1,
  "requestId": "demo-001",
  "rawText": "1. 下列哪个数是偶数？\nA. 3\nB. 4",
  "stem": "下列哪个数是偶数？",
  "options": [{"id":"input-a","text":"3"},{"id":"input-b","text":"4"}],
  "bankIds": [],
  "limit": 5,
  "normalizationVersion": "text-v1"
}
```

protocolVersion、requestId、stem 必填；rawText 可为空；options 和 bankIds 缺省为空列表；limit 默认 5，范围 1–10。bankIds 为空表示查询当前用户可访问且已就绪的本地题库。stem 为空为 invalid_request。requestId 在一次会话中唯一，服务按调用者与 requestId 管理取消。

P1 例外限定：演示库固定为 demo-bank；悬浮窗显式请求 bankIds=["demo-bank"]。服务在生产身份鉴权完成前，只允许内置演示库，不能因 bankIds 为空或客户端自报身份而返回真实个人数据。该演示免登录逻辑不适用于正式公共题库。

题型扩展已在 question-types-v1.md 定义，由 R2 实现；冻结 P1 服务仍可能忽略新增请求字段，客户端须通过能力声明和候选元数据判断支持情况。OCR 质量信息可后续以可选字段追加。未知可选字段忽略；不支持的协议主版本返回 incompatible。

## 响应 JSON

```json
{
  "protocolVersion": 1,
  "requestId": "demo-001",
  "status": "matched",
  "source": "local",
  "normalizationVersion": "text-v1",
  "candidates": [{
    "questionId": "demo-q1",
    "bankId": "demo-bank",
    "dataVersion": "demo-1",
    "stem": "下列哪个数是偶数？",
    "options": [{"id":"opt-3","text":"3"},{"id":"opt-4","text":"4"}],
    "answerText": "4",
    "answerOptionIds": ["opt-4"],
    "explanation": "4 能被 2 整除。",
    "sourceName": "内置演示题库",
    "matchType": "exact",
    "score": 1.0
  }],
  "elapsedMs": 12,
  "message": null
}
```

示例数值仅演示字段，不是性能实测。elapsedMs 为服务内部本次查询耗时，不包含截图/OCR/连接。score 是排序分数，不是答案正确概率。answerOptionIds 指向题库自身 options，客户端必须按选项内容映射查询选项，不能直接把题库序号当成截图序号。

status 取值：matched、ambiguous、not_found、not_ready、invalid_request、incompatible、unauthorized、unavailable、timeout、cancelled、error。matched 表示通过当前匹配规则确认唯一匹配；含糊的候选用 ambiguous，界面不能伪装成确定答案。not_found 的 candidates 为空。连接失败等可由客户端生成对应状态；权限拒绝也可能以 Android SecurityException 表达，客户端需映射。

getStatus() 返回短小 JSON：protocolVersion、ready、normalizationVersion、banks（每项含 bankId/dataVersion）、syncState。syncState 首期可为 idle/not_configured；没有真实同步功能时明确标记，不冒充已接通云端。该方法只读内存状态，不做同步、建库或网络请求。

P1 增补可选字段 authMode="demo_only"，用于明确演示状态；banks 只包含 demo-bank 元数据。旧客户端忽略新增字段，AIDL 签名不变。未来正式身份模式必须通过独立认证合同接入；principalId/sessionEpoch 之类校验字段不能代替可信会话。

## 内容处理边界

- 悬浮窗负责裁剪、OCR 文本块的阅读顺序、界面噪声识别、题干/选项拆分，保留 rawText。
- 题库负责最终标准化和匹配。text-v1 仅对明确的全角 ASCII、空白与非语义换行做安全处理，不进行会丢失数学语义的全局 Unicode 兼容折叠。
- 保留否定词、数字、单位、正负号、上下标、比较符号和公式。题号/选项标签按结构剥离，不删除题干中的数字或字母。
- 同样的规则用于题库入库与查询。原型先在题库侧实现，悬浮窗不另写一套语义纠错规则。
- 至少验证：同题不同空白、选项换序、否定词变化、数值变化、相似题、无答案题、无匹配、识别不完整和快速连续查询。

## 第一阶段范围

先验证“题库后台按需启动＋样例本地索引＋截图/OCR＋展示答案”。允许题库用明确标记的内置演示数据建立原型，不能把它当成已经完成管理员上传和云端分发。

云端降级首期保留接口适配边界；未配置真实云端时明确提示，不调用编造地址。后续云端查询沿用本合同的业务语义，传输与认证另行约定。统一账号、个人多格式导入、私人自动同步、管理员审核发布和公共增量同步均保留在完整计划中。
