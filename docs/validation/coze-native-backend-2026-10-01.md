# Coze 原生后台迁移

日期：2026-10-01；项目 `new float ai` / `7689833705046130729`。

## 最新授权

用户同意整个后台迁入 Coze，并明确舍弃旧账号和私人题库。方案改为初始化新库；没有删除旧服务器数据。SSH 一次性表单进程已关闭。首位管理员手机号仅配置在 Coze 环境，不写 Git 和文档；完成正常短信注册才授予角色。

## 源码改动

- 原账号、短信、点数、导入、管理、模型、回执适配异步接口，页面和 API 保留。
- AsyncSqliteStore 包装原本地 Store；PostgresStore 使用专用 float_ai schema、版本迁移、安全整数和 BYTEA、事务固定连接及跨实例写锁。无自动短信／模型重试。
- 幂等确认、刷新、纠错和审核原子提交并重新鉴权；刷新重用的撤销真正提交，异步数组正确等待。
- 恢复只处理过期／超过90秒请求，避免新实例中断其他实例；模型测试仅更新最新 testId 状态，各次回执保留。
- Coze 唯一 HTTP 入口直接分发 /v1 和 /health，DEV／PROD 提供相同网站。当前入口不调用旧上游代理。
- SDK ensureDatabaseEnvironment／ensureSupabaseEnvironment 获取固定项目配置；实际数据库变量是 PGDATABASE_URL_DEV／PGDATABASE_URL_PROD。
- nativeModelBridge 与 HMAC 路由复用真实 SDK 目录、usage、结束状态及预算校验。未验证型号不自动启用。
- 受保护 GET /internal/backend-status 先鉴权，再分项读取真实身份、数据库、目录和手机号开关；128 KiB 上限、不缓存、不返回凭据或完整认证配置。
- 指定手机号完成真实注册，且库内无管理员，才授予首位管理员。DEV／PROD 独立注册。

## 检查与边界

最终 12 个 JS 语法、TypeScript、受影响 ESLint、Next 完整构建和 Node24 入口打包通过；动态模块加载告警已修正，原始 ESM 后台文件纳入部署追踪。未新增或运行测试。

31 个文件已同步 GitHub 提交 `258132188af47e7c2b961a3018769772428864d7`，以 Git Data API 正常向前更新；远端树与提交核对一致，本地 main／origin/main 同步且干净。独立同步证据见 `coze-native-source-sync-2026-10-01.json`。

首位管理员配置已存 DEV。CLI 源码确认部署读取 DEV 最新环境并加密传给 PROD；当前旧 PROD 快照未包含该配置，新部署后仍需核验。

浏览器库存可读取，但绑定既有 Coze 标签仍超时。未使用占位 CLI Pull，未发 Coze AI 修改消息。云端数据库、短信、真实生成和部署等待新代码 Pull 后核验，不能把构建成功写成上线。

07:19 UTC 只读请求实际 DEV 的 `/health` 与受保护 `/internal/backend-status`，均为 HTTP 404，未获得新原生后台状态。已请求用户 Pull `2581321` 并重启预览；该结果不能证明数据库或模型已运行，也没有发起生成。记录见 `coze-native-runtime-status-2026-10-01.json`。

启动路径独立复核确认 DEV 使用 tsx 原生入口，PROD 使用 Node24 CJS 入口，原始 ESM、解析 worker 和静态资源已 Git 跟踪，直接依赖均可解析。发现 HTTP 与 Next 诊断分别打包模块局部状态会创建两套后台，已改为 globalThis 固定 Symbol 共享后台 Promise、重试状态和关闭 Promise；业务与诊断检查同一进程实例。同时补安全失败阶段／HTTP状态诊断，不输出错误原文／连接串／响应对象；优先使用平台注入的项目 DEV／PROD PostgreSQL URL，避免 SDK 仅检查 .env 而重复 ensure。类型／ESLint／完整 Next 构建及 Node24 打包通过，未运行测试。部署保持完整安装、非 standalone；若平台裁剪为 nft，需核实其依赖保留策略。

用户确认 Pull 后，07:22 UTC DEV `/health` 已变为业务 503，授权诊断为200，固定项目／DEV／cloud配置检查通过。数据库初始化仍失败，短信配置和模型目录尚未读取，不能证明 token 远端授权有效；SDK三个集成都使用同一官方 integration 入口。待新诊断补丁 Pull 后分辨具体阶段和上游 HTTP 状态。本轮未触发生产部署、短信发送或真实生成。

v41 APK 和冻结服务包保留，无手机操作。图片 OCR／扫描 PDF、云端三级目录、客服兑换等原剩余项不属于本轮已完成能力。

## 平台依据

依据本机 coze-coding-dev-sdk 0.7.32 正式类型及实现，以及 [数据库说明](https://docs.coze.cn/guides_integrate_database)、[身份验证说明](https://docs.coze.cn/guides_integrate_authentication)。部署结构和数据分开；SSL 沿实际URL并保留证书验证，不猜证书或关闭验证。
