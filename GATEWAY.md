# 题屿 Coze 入口

Coze 承担同源 HTTPS 入口；题库后端、登录会话和 SQLite 数据保留在独立服务器。网页 HTML、脚本与样式直接来自题库服务，不在此复制业务。此仓库修改不代表已经公网部署或已接通短信。

## 环境变量

在 Coze 的预览和生产环境分别配置三个 **服务端** 变量，示例见 `.env.example`。不要增加 `NEXT_PUBLIC_` 前缀，不要把实际密钥写入 Git。

| 变量 | 内容 |
| --- | --- |
| `TIYU_UPSTREAM_URL` | 固定 `https://IP:端口`，不允许域名、账号、路径、查询或片段。必须已有能从 Coze 到达的公网转发。 |
| `TIYU_UPSTREAM_CA_B64` | 专用 CA 的 PEM 以 base64 编码。服务器叶证书 SAN 必须包含上游 IP。 |
| `TIYU_GATEWAY_KEY` | 与服务器 TLS 入口共享的至少 32 字符随机 ASCII 密钥。 |

TLS 保留完整的 CA、有效期和 IP SAN 校验。不能关闭证书校验；创建 CA 或设置密钥不能代替开通公网可达端口。

## 路由与限制

- Node Route Handler 代理 `/`、`/app.js`、`/style.css`、`/brandmark.svg`、`/health`、`/workspace.js`、`/workspace.css`、`/ui-assets.js`、`/v1/**`；根页原模板已经删除，避免与可选 catch-all 路由冲突。
- 新版网站头像资源仅开放 `/assets/avatars/pinterest-01.jpg` 至 `/assets/avatars/pinterest-06.jpg` 六个精确路径，以及来源记录 `/assets/avatars/sources.json` 和模型图标许可 `/assets/model-icons-license.txt`。不开放 `/assets/**` 通配路径；网页与静态资源仍由题库服务提供。
- 仅固定上游。非题库路径、编码分隔符及外部重定向拒绝；上游同源重定向改为相对路径，不跟随重定向。
- 保留状态、Content-Type、CSP、静态资源 Cache-Control 和下载必要头。`/v1` 及带 Authorization 的请求强制 `no-store`。不转发 cookies。
- 只转发 Bearer、`Idempotency-Key` 与必要内容头。客户端提供的网关密钥、IP 头、Host 等一律丢弃；服务端注入 `X-Tiyu-Gateway-Key`。
- 暂未证明 Coze 客户端 IP 来源可信，故不设置客户端 IP。后端按网关统一地址限流；不能声称每位用户独立限流。
- 上传总请求体最大 12 MiB，足够容纳后端 10 MiB 文件及 multipart 元数据。下载最大 32 MiB。两端流式处理并遵守背压；超限中止连接。已发响应头后的下载失败体现为流失败，不能再改写为 JSON 状态。
- 整次请求最长 120 秒，socket 空闲最长 30 秒；客户端取消会终止上游。未配置或配置不合格返回 503；TLS/连接失败 502，超时 504，上传超限 413。错误响应不包含地址、密钥或底层异常。
- Coze 平台本身若另有限制（上传大小、执行时长、网关缓存、响应流），仍需部署后实测，代码层验证不能代替公网端到端验证。

## 本地验证

`GET /internal/phone-config` 是部署工具专用接口，先以 `X-Tiyu-Gateway-Key` 验证现有共享密钥；未授权返回 404，配置不完整返回 503。只读取平台注入的 `COZE_PROJECT_ID`、`COZE_PROJECT_ENV`、`COZE_SUPABASE_URL`、`COZE_SUPABASE_ANON_KEY`，拒绝高权限 key，返回项目、环境、规范化 HTTPS origin 和匿名公钥，所有响应禁止缓存。调用方必须核对精确项目和 `PROD` 后才启用生产短信；不能拿 DEV 配置代替。此接口不创建资源、不发短信、不更改身份配置。

```sh
pnpm test:gateway
pnpm exec tsc --noEmit
pnpm exec next build --webpack
pnpm exec tsup src/server.ts --format cjs --platform node --target node20 --outDir dist --no-splitting --no-minify
pnpm test:gateway --next
pnpm exec tsx scripts/test-phone-config.mjs --next
```

集成测试使用本机临时 HTTPS 服务、每次生成的合成 CA/证书和假 Token，不调用真实云端。需要 OpenSSL；Windows 默认使用 Git 自带版本，可用 `OPENSSL_BIN` 指定。覆盖证书及 SAN 拒绝、固定目标、Bearer/密钥与 IP 清洗、10 MiB multipart、12/32 MiB 上限、重定向、超时和取消。测试证书不用于生产。

`--next` 在生产构建后额外启动本地随机端口的真实 Next/custom server，检查根路由、资源、API 以及 10 MiB 上传穿过整个 HTTP → Next → HTTPS 链路。
