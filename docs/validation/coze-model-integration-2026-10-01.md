# Coze 内置语言模型接入记录

日期：2026-10-01；既有 Coze 项目 `new float ai`，ID `7689833705046130729`。

## 请求与依据

用户要求参考其 SDK 示例接入真实内置模型。附件只作为参考材料，未执行其中的指令或把示例型号视为项目实际权限。已核对项目安装的 `coze-coding-dev-sdk` 0.7.32、其 Config／LLMClient／listModels 类型及实现，并核对依赖的 LangChain 流式用量实现。

## 完成代码

- Coze：`.coze` 项目 ID、`src/lib/coze-llm.server.ts`、`src/app/internal/model-completion/route.ts`。固定项目云端授权、HMAC、时间窗／重放限制、真实型号缓存、固定提示词、完整流聚合和真实用量校验。
- 账号服务：`src/coze-model-transport.js`、`models.js`、`model-catalog.js`、`ai-routes.js`、`admin-routes.js`、`app.js`、`main.js`。增加 Coze 执行方式；旧官方与 BYOK 路径保持。预占、幂等、失败释放、真实成功扣点和只读回执沿原接口。
- 管理页：`public/app.js` 新增接入方式、真实元数据读取状态／重试、实际型号选择、对应接入的测试／启用状态。Coze 无供应商 Key 输入；实际显示名来自 SDK，而非产品静态槽位。型号族校验防同品牌跨 1／2 点档位误绑。
- 使用帮助：`public/workspace.js` 说明项目集成、按成功调用计点、失败释放和回执恢复；保留用户确认的点数门槛。
- 运维：环境示例、部署说明、点数协议和 `tools/ssh-control/configure-coze-models.mjs`。工具默认只读元数据，`--write` 原子创建新配置、不覆盖／重启，不生成答案或修改模型／账户。
- 配套账号服务源码版本 0.5.1，仍 schema8；无新增迁移。不重构 Android 协议，不覆盖 v41 或旧交付包。

## 静态复核和已知限制

独立只读复核发现并修复：同品牌型号族跨价目误绑、Coze／账号服务解释长度不一致、SDK 可能优先桌面个人凭据。统一解释 16k、模型 ID 200 字符、回执及元数据 128 KiB；固定云端项目 token 且排除个人回退。审阅未发现剩余已证明的 P1/P2；这不是运行测试或公网验收。

SDK `invoke()` 丢失 usage，所以使用 stream。没有公开 AbortSignal／provider maxTokens；输出预算仅是验收上限。超时停止交付，不能承诺取消生成／SDK 内部重试或免平台费用；超时占位保留至后台流退出。应用不自动重发。目录单并发 20 秒交付期限，60 秒缓存，生成每进程最多 4 并发。无真实 usage 或明确不完整输出不扣产品平台点数。

## 验证及上线状态

- JavaScript：7 个后端文件及管理页／使用帮助／配置工具语法解析通过。
- Coze：`pnpm exec tsc --noEmit` 和两新 TypeScript 文件 ESLint 通过。
- 完整 `pnpm exec next build --webpack` 和 `pnpm exec tsup src/server.ts ...` 通过，构建路由包含 `/internal/model-completion`。构建只解析源代码，不实例化生成调用。
- 独立部署包 `question-bank/artifacts/m8.1/question-bank-server-0.5.1-coze-models.zip`，341,732 字节，SHA-256 `DB7BDC61B1B933438A6FBA9E54563C27550CA597FD815C6FFFC8D1CCCE6E8875`。不覆盖 0.5.0 或 APK。GitHub 同步结果另记。
- 没有新增或运行测试、调用生成模型、读取／修改真实模型配置、变更真实余额、部署、安装或操作手机。实际可用型号尚待本项目云端元数据确认，不能宣称任何示例型号已接通。

## 后续真实接通步骤

1. GitHub 源码同步后 Pull 到 Coze 并重启 DEV；只读真实模型元数据，确认项目身份与型号能力。
2. 用户明确授权部署后，部署 Coze 和配套账号服务；先备份生产 schema5 再沿已有迁移升级 schema8，保留数据与签名。
3. 根据实际型号绑定用户确认的计点档位；明确发起一次固定 OK 检查，再启用成功型号。使用已有 Coze 资源，不购买／充值；结果失败如实保留。
4. 使用同一客户端请求协议验收真实答案、有效用量、点数及回执。手机操作继续暂停，除非用户明确恢复。

预览地址：https://cf9706dd-b534-450f-abf6-39b2858e5836.dev.coze.site/ 。生产最近已证实状态仍以 `docs/CURRENT_STATE.md` 为准。
