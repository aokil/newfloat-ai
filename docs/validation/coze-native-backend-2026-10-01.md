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

本地 JS 语法、TypeScript、受影响 ESLint、Next 完整构建和 Node24 入口打包通过；最终整合复核继续追加。未新增或运行测试。

浏览器库存可读取，但绑定既有 Coze 标签仍超时。未使用占位 CLI Pull，未发 Coze AI 修改消息。云端数据库、短信、真实生成和部署等待新代码 Pull 后核验，不能把构建成功写成上线。

v41 APK 和冻结服务包保留，无手机操作。图片 OCR／扫描 PDF、云端三级目录、客服兑换等原剩余项不属于本轮已完成能力。

## 平台依据

依据本机 coze-coding-dev-sdk 0.7.32 正式类型及实现，以及 [数据库说明](https://docs.coze.cn/guides_integrate_database)、[身份验证说明](https://docs.coze.cn/guides_integrate_authentication)。部署结构和数据分开；SSL 沿实际URL并保留证书验证，不猜证书或关闭验证。
