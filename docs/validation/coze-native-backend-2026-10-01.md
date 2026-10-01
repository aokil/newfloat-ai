# Coze 原生后台迁移

日期：2026-10-01；项目 `new float ai` / `7689833705046130729`。

## 最新适配结果

- 用户确认 Pull `b3ffe38` 后，07:35 UTC 新诊断运行；数据库失败在配置阶段，短信 API 业务码 `190000007`，模型目录 HTTP200 业务失败。未从业务码猜测具体原因。
- 现有 CLI owner OAuth 只在本机内存使用，正式 DEV／PROD 模型目录均返回 9 个真实型号；保存无凭据目录快照 `src/lib/coze-project-models.json`。SDK `listModels()` 只支持新 user-OAuth 路径，不能把 workload token 回写成 `COZE_API_TOKEN`。
- workload 兼容 Config 仅对受固定项目／DEV-PROD／cloud 保护的实例赋 `apiKey`，不改全局凭据；真实生成沿 SDK 正式流式调用。workload 目录明确 `owner-verified-snapshot`，更新时间可查询，连接测试前不启用型号。诊断 `generationVerified:false`，不把取得目录当作生成成功。
- 加入官方 `@coze/workload-identity@0.1.0`；资源请求 single-flight、60 秒缓存、10 秒失败冷却，固定首次凭据身份。只读当前 phase 的 PG/TIYU Supabase 变量，不接通用数据库／短信地址；状态不输出凭据、URL或异常原文。
- 正式 DEV database/ensure、supabase/ensure 已返回 code0。平台不允许自定义 `COZE_` 变量名，改保存 `PGDATABASE_URL_DEV`、`TIYU_SUPABASE_URL_DEV`、`TIYU_SUPABASE_ANON_KEY_DEV`，08:04 UTC 正式读取核对值一致。身份配置原始 `ProjectID` 保留大整数精度后匹配，手机号开关为 true；未发送短信。生产没有初始化或配置，DEV 成功不代表 PROD 就绪。
- 没有把 owner OAuth 保存到环境、源码、文档、命令参数或本地文件；配置写入用官方 CLI HTTP 客户端内存结构化请求，未调用会打印值的 CLI env set。
- 最终 TypeScript、受影响 ESLint、Next 完整构建及 Node24 入口打包全部通过，构建生成文件已恢复。没有新增／运行测试、模型生成、生产部署或手机操作。新适配须 Pull／重启后核验真实后台、短信和生成。

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

本轮12文件已同步 5f79dfdbfcb347a27fff93e4a85d724ac1dd5604，远端树／哈希核对一致、本地main／origin/main干净。同步证据 coze-native-workload-sync-2026-10-01.json。08:07 UTC 预览 /health 与受保护诊断返回404，浏览器控制库存超时；已请求用户Pull本轮新补丁并重启预览。未进行真实生成、短信发送、生产部署或手机操作。

## 最新真实运行结果（08:16–08:26 UTC）

- 用户Pull后，DEV健康与受保护诊断均HTTP200：PostgreSQL/schema8、固定项目/cloud/workload身份、短信开关true、9型号真实目录就绪。
- 正式DEV workload对豆包Mini发出真实文本连接请求，返回OK，prompt/completion/total tokens为62/1/63，862ms。它证明模型链路，不写管理员配置或测试状态、不修改账号／余额。证据coze-native-model-connection-2026-10-01.json。
- PROD官方database/ensure、supabase/ensure、身份配置读取及秘密保存均code0；当前phase的3个PG/TIYU变量读回值一致。PROD业务数据库端点／库名与DEV不同；短信provider由项目共享。变量保存在DEV secret以供部署读取加密复制，不部署owner OAuth。证据coze-prod-resources-2026-10-01.json。
- Coze提交列表确认5f79dfd存在，最新d769e9c是以5f79dfd为parent的GitHub合并。任务状态done，无进行中的开发任务。
- 用户已回复注册，但只读DEV业务PG聚合显示1个已验证启用的普通账号、0管理员；BOOTSTRAP_ADMIN_PHONE与用户重申号码一致，该号码在本DEV库没有账号。未读取密码／会话、未改账号角色或余额。证据coze-native-deployment-preflight-2026-10-01.json。
- 9项真实元数据缺少SDK定义的可选input_types/output_types；现有保存门槛误把未知当不支持，最小修复进行中。未知能力只允许停用草稿，明确非文本能力拒绝，对应管理员文本测试通过后方可启用。
- 尚未部署PROD、配置／启用模型、完成指定号码真实注册及管理员验收。DEV／PROD账号、模型配置和测试记录独立；手机／APK保持暂停。

## 可选模型能力字段修复（08:30 UTC）

SDK元数据的input_types/output_types可选；本项目真实9项均未声明。已修正为仅非空列表明确排除text才拒绝，不补造能力；允许停用草稿，原有真实管理员测试／配置revision／启用门槛保持。两份admin-routes.js语法、TypeScript、完整Next webpack生产构建及Node24打包通过；未新增／运行测试。当前DEV后台及Mini真实链路已运行，但本项保存修复需新代码Pull后生效；指定手机号注册／管理员和实际模型配置／启用、PROD部署仍未完成。
