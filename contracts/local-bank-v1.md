# 单 App 本地题库合同 M1

日期：2026-09-27。主控冻结的当前实现基线。用户已明确合并为一个安卓软件，并在软件内点击“更新题库”。本合同覆盖旧 query-v1 的安装身份、AIDL 和跨 App 生命周期要求；题目业务字段、text-v1 与 question-types-v1 仍沿用。

## 1. 模块与安装

- 唯一产品 APK：floating-app，applicationId 保持 com.newfloat.floating，显示名“题库浮窗”。
- 共享纯 Kotlin 模块：question-bank/android/core；Android 库：question-bank/android/local-bank。
- 宿主 Gradle 使用 :core、:local-bank 引用上述目录；库依赖 project(":core")，插件版本由构建宿主统一。
- 新库空 manifest，不声明 Application、Activity、Service、QUERY 权限或 AIDL。旧 question-bank/android/app 仅作历史演示/回归，产品不依赖其安装、页面或进程。
- 数据库、匹配、索引和更新归题库模块；宿主只通过库入口调用，不复制算法或自行读写 SQLite。
- 一个进程内应用级单实例，Activity 与截图前台服务共用。不得由页面销毁关闭仍在使用的库。

## 2. 精确 Kotlin 入口

包名 com.newfloat.questionbank.local。耗时 API 均为同步，由宿主后台 worker 调用，不在主线程做数据库或网络操作。

```kotlin
class LocalQuestionBank(context: Context, updateSource: UpdateSource? = null) {
    fun initialize(signal: CancellationSignal = CancellationSignal()): JSONObject
    fun getStatus(): JSONObject
    fun query(request: JSONObject, signal: CancellationSignal = CancellationSignal()): JSONObject
    fun update(signal: CancellationSignal = CancellationSignal(),
               onProgress: (JSONObject) -> Unit = {}): JSONObject
    fun close()
}
```

initialize 与 close 幂等；初始化只建立/恢复当前快照，不发起网络更新。getStatus 只读取内存快照，返回独立 JSON，不把内部可变对象交给调用方。UpdateSource 的具体网络/流接口由题库模块封装并在其集成说明中给出；构造的默认 null 不联网。

query 沿用 query-v1 请求/响应的业务 JSON 和 question-types-v1，增加 transport="in_process"。库在解析、索引访问、比较中检查 signal 和 5 秒查询预算；宿主保留 7 秒整体超时、RequestGate、候选确认和过期结果丢弃。同一次查询固定数据库版本，不混用更新前后记录。初始化前返回 not_ready；关闭后返回 unavailable，不崩溃。取消、超时和失败不返回可自动采用的候选答案。

业务兼容仍以现有20条R2夹具为准：legacy unknown题可按原规则返回matched且answerComplete=false用于兼容展示，绝不能因此自动复制/推断题型。已知题型但答案不完整仍为ambiguous。请求不包含可访问题库时返回not_found，不通过空结果泄漏其他题库信息；查询过滤始终只允许demo-bank。更新包声明非法身份则为unauthorized，与查询范围无命中区分。

getStatus/initialize 至少返回 protocolVersion=1、normalizationVersion="text-v1"、authMode="demo_only"、transport="in_process"、ready、capabilities=["question-types-v1"]、banks、syncState、updateConfigured；banks 每项为 bankId/dataVersion/questionCount，更新后必须反映实际提交版本。

## 3. 本轮数据与身份范围

M1 仍是无生产账号的演示原型，只允许 demo-bank，初始内容为现有 19 题 demo-r2-1。新 APK 在自身沙箱初始化；不声称能读取旧独立题库 App 的私有数据库。已安装用户的浮窗偏好原位保留，旧尺寸迁移到 16–32dp，默认/上限 32dp。

未登录真实个人导入、真实私人同步、生产公共库和管理员发布均须后续认证合同。不能用“合并在同一进程”绕过所有权检查，也不能通过下载包中的 authMode/ownerUserId 自行提升访问范围。统一产品使用一个 Android 会话；电脑网页是同一账号体系的另一个客户端。

## 4. 更新语义与清单

点击“更新题库”执行检查 → 下载完整快照 → 校验 → 建索引 → 原子应用。已有题库在检查和下载时可继续查询。M1 实现完整快照替换，含新增、修改和删除；增量链后续实现，不能只追加记录冒充全量替换。

更新结果 JSON：updateId、status、message、banks（返回时实际生效版本）。status 只能为 updated、up_to_date、not_configured、not_ready、busy、cancelled、failed、incompatible、unauthorized。无源返回 not_configured，不得返回 updated/up_to_date。up_to_date 必须来自实际源清单比较，updated 只在持久化提交完成后返回。重复更新互斥为 busy；查询可独立取消。onProgress 只报告真实阶段 checking/downloading/validating/indexing/applying，不伪造进度百分比。

M1 演示清单 JSON（不是生产公共发布协议）：

```json
{
  "manifestVersion": 1,
  "authMode": "demo_only",
  "bankId": "demo-bank",
  "dataVersion": "demo-m1-2",
  "releaseSequence": 1,
  "normalizationVersion": "text-v1",
  "questionCount": 19,
  "package": {
    "format": "question-bank-json-v1",
    "url": "https://example.invalid/releases/demo-m1-2.json",
    "sha256": "<64位十六进制>",
    "sizeBytes": 12345
  }
}
```

示例地址仅说明结构，不可作为默认联网端点。包为 UTF-8 JSON：schemaVersion=1、authMode、bankId、dataVersion、normalizationVersion 与清单一致，questions 为完整题目数组。每题字段沿用题库 Question 的存储语义，保留题干、选项、答案、解析、来源、类型、完整性、布尔值和有序填空答案；填空结构证据字段使用 expectedBlankCount，库可映射至内部存储字段。每题 bankId/dataVersion 与包一致，questionId 唯一且非空。禁止凭缺失字段伪造完整答案；不完整题可以保留但不能自动复制，legacy unknown展示遵循上文兼容例外。非法结构/冲突元数据导致整包失败。

releaseSequence 初始内置版本为 0，新源序列必须更高；相同序列仅在 dataVersion 与已保存包哈希一致时算 up_to_date；同序列异版本/哈希、较旧序列、较新序列复用旧 dataVersion 均拒绝。初始内置版本无远端包哈希，首次源应使用新版本与正序列。保存序列、哈希和数据库版本必须与切换同步，重启后仍可检查。

HTTP UpdateSource 正式仅接受 HTTPS，包 URL 与清单同源，不自动跨源转发认证或跟随重定向。仅 debug 显式允许 loopback HTTP 以验证本地夹具；不允许任意公网 HTTP。验证声明和实际下载字节数、SHA-256、协议/标准化兼容性、题数、身份范围、唯一 ID 与结构答案。网络超时、断流、磁盘不足、校验失败或提交前取消保留旧库。提交后按实际结果返回 updated，不能已落库却返回 cancelled。

实现必须有单清单/单包资源上限、流式下载和及时取消；资源上限是本轮原型处理预算，不是产品总题数上限。具体数值在模块文档中公开，未来分包支持不得被误称为无限单包能力。

## 5. 验收与交付

1. 仅装统一 APK 也能初始化、查到各题型、取消请求；旧题库 APK 和进程完全不参与。
2. 既有 20 条 R2 题型夹具和快速替换回归；旧答案/旧计时器不影响新题，自动复制沿用严格条件。
3. 未配置源点击更新明确 not_configured；本地 HTTP 夹具演示实际下载/增删改/索引生效/重启持久化，再次检查 up_to_date。
4. 坏哈希、版本回滚、取消、并发更新和无效结构保留旧数据；更新与查询并发不混版本。
5. 新包存 floating-app/artifacts/m1，旧 P1/R2/R2.1/R2.2 冻结文件不覆盖。真机测试由悬浮窗任务唯一操作小米17/92f9bcb9。
6. 当前无生产云端地址，不能把夹具服务或演示题库称为已部署云更新。实际截图授权、OCR、透明尺寸、剪贴板和规模性能分别记录证据，不能用构建结果替代。
