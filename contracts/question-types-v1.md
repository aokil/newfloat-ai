# 多题型扩展 question-types-v1

日期：2026-09-27。状态：R2 实现基线已确定，由两个执行对话实施；不是冻结 P1 包已有的能力。

本扩展在 query-v1 的 JSON 上添加可选字段，protocolVersion 仍为 1，AIDL 不变。标准化仍为 text-v1，不借题型扩展改变数字、否定词或数学符号处理。

## 1. 能力发现与兼容

实现本扩展的服务在 getStatus() 中增加 capabilities 数组，包含 "question-types-v1"。只能在题型验证和答案输出真正实现后声明能力。P1 不包含该能力时，客户端仍可使用原查询与显示，不启用本扩展的填空/简答自动复制。

P1 冻结 APK 保持不变。R2 使用独立 artifacts/r2/ 产物；题库可采用新的演示数据版本 demo-r2-1，bankId 仍为 demo-bank。演示访问过滤只覆盖明确内置的数据集，不能借新版本放开真实公共或私人数据。

## 2. 题型字段

请求可选字段 questionType，以及每个候选题的 questionType，共用以下枚举：

| 值 | 含义 |
| --- | --- |
| single_choice | 单选 |
| multiple_choice | 多选 |
| true_false | 判断 |
| fill_blank | 填空 |
| short_answer | 简答 |
| unknown | 未识别或尚未支持的类型 |

请求缺少此字段或收到未知字符串值时按 unknown 处理；字段存在但不是字符串时返回 invalid_request。旧记录缺字段时读取为 unknown，不能把 options=[] 自动推断成填空/简答。对外不得使用 single、multiple、judgment、fill、short 等内部别名。

## 3. 候选答案字段

保留 query-v1 所有原字段；新增可选字段如下。实现了本扩展的服务须对其返回的每个候选明确填入 questionType 和 answerComplete。

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| questionType | string | 上述题型枚举 |
| answerComplete | boolean | 按当前题型与资料校验答案完整且可用；不能只因存在非空预览文字就设为 true |
| answerBoolean | boolean | 判断题的明确真假值；false 是合法答案，与缺失不同 |
| answerParts | array | 填空题的有序空位答案，每项为 {position: 正整数, text: 非空字符串} |

answerText 始终保留为完整答案的纯文本表示；不能用摘要替代，也不混入解析 explanation。选择题保留 answerOptionIds（题库自身稳定选项 ID），客户端按选项内容映射截图字母。

- 单选：answerOptionIds 恰好一个有效选项 ID。
- 多选：一个或多个无重复的有效选项 ID；不截断成单项。所有 ID 必须指向该题 options。
- 判断：answerBoolean 必须是真正的 JSON boolean，answerText 与其一致，建议为“正确”或“错误”。不能因缺失字段而默认 false。
- 填空：answerParts 的 position 从 1 连续递增，text 非空，与资料中应有空位对应；不能用逗号/换行猜测拆空。单空 answerText 为该空答案，多空建议为“1. 答案一\n2. 答案二”。备选表达与多个空不得混淆；当前每空使用资料给出的标准答案。
- 简答：answerText 为完整正文，保留段落；没有完整文本答案时 answerComplete=false，不把“见解析/见图”当作已提供全部答案。
- unknown：保持旧文本展示兼容，不因此启动自动复制或宣称类型已确认。

示例候选增补（省略原有题目、来源和版本字段）：

```json
{
  "questionType": "fill_blank",
  "answerComplete": true,
  "answerText": "1. 北京\n2. 上海",
  "answerOptionIds": [],
  "answerParts": [{"position":1,"text":"北京"},{"position":2,"text":"上海"}]
}
```

## 4. 匹配语义

- 请求和候选都有明确题型但不一致，不能返回 matched；可返回带解释的 ambiguous 候选。
- 请求有明确类型而候选是 unknown，也只能候选展示，不绕过类型核对。
- 请求是 unknown 时，可召回已知题型；满足精确题干、该题型校验、唯一候选和答案完整条件才可 matched。
- 单/多选继续核对选项内容及数量，缺选项不能误判为填空或简答。
- 判断、填空、简答可以没有选项。判断可带“对/错”等展示选项，但答案以题干与明确布尔语义核对，不要求为了检索人为添加选项。
- 已知类型的答案不完整、候选冲突或识别缺损时返回 ambiguous，不自动补写资料没有的答案。
- unknown 请求与 unknown 旧记录保留原精确查询兼容行为；缺少新答案完整性字段的旧响应视为未获自动复制许可。
- limit 只限制展示条数，不得把多个冲突候选截成一个后改为 matched。

## 5. 自动复制条件

由悬浮窗执行复制，题库服务不访问剪贴板。须同时满足：

1. 当前服务支持 question-types-v1，候选题型明确为 fill_blank 或 short_answer。
2. 当前请求/会话仍有效，未取消、未换号，answerComplete=true 且 answerText 非空。
3. 状态 matched 且只有一个确认候选，或用户显式选择了完整候选并解决了识别歧义。
4. 同一结果此前未自动复制。

复制完整 answerText，界面可以只显示摘要。未命中、未确认候选、过期回包、unknown、仅有 OCR 题型提示或旧服务缺少能力声明时不自动复制。手动复制入口可展示实际内容后由用户使用。

## 6. 共同验证样例

R2 至少验证单选/多选换序、单选多答案数据拒绝、无效选项 ID、判断 false 与缺失不同、无选项判断、多空顺序、简答段落、空答案、题型冲突、unknown 兼容、limit=1 冲突、旧服务不触发复制。全部题型仍沿用演示库/身份范围约束。

合同确认后题库侧实现 typed 模型、检索与演示样例；悬浮窗实现 OCR 类型提示、响应核对与剪贴板行为。真实身份和私人数据仍遵循 P1A 前置条件，不能用题型扩展绕过。
