# M8 服务部署与运行

## 当前：Coze 原生后台 0.6.0

用户授权全部后台迁入既有 Coze，并舍弃旧账号和私人题库。**初始化新库，不需要 SSH 或旧数据导出。**下方独立服务器和执行桥步骤为历史说明。

- 唯一 HTTP 服务直接运行现有 /v1 Fastify 接口，提供同一网站。Node24，后台 ESM 源码保持独立部署，避免破坏 worker 和静态文件的 import.meta.url。
- SDK 解析 PGDATABASE_URL_DEV／PGDATABASE_URL_PROD；使用专用 float_ai PostgreSQL schema8，原件存 BYTEA，云端不使用工作目录 SQLite。
- DEV／PROD 数据独立。首次部署仅同步结构，初始化空生产库；以后不复制开发数据。完整空结构缺版本行时，经完整结构和空数据验证才补标记。
- 短信配置由 SDK ensureSupabaseEnvironment 在内存读取，平台手机号开关须支持并开启。BOOTSTRAP_ADMIN_PHONE 指定手机号完成真实注册、库内无管理员，才授予首位管理员，不预建密码／跳过验证码。
- 内置模型直接调用项目 SDK；管理员读取真实目录、绑定1／2点档位、测试并启用。官方／自带 Key 规则保持，平台令牌不进入浏览器或 APK。
- TIYU_GATEWAY_KEY 保护状态接口，并按用途派生服务端密钥。使用已加密官方模型 Key 后，轮换网关 Key 须保留独立 MODEL_MASTER_KEY，避免旧密文无法解密。
- /health 查询实际数据库；受保护 /internal/backend-status 分项验证身份、数据库、真实目录及手机开关，不返回凭据。

实际云端运行以 docs/CURRENT_STATE.md 为准，本地构建不等于 Pull／部署；手机仍暂停。见 [迁移记录](../../docs/validation/coze-native-backend-2026-10-01.md)。

## Coze 内置模型候选（2026-10-01）

最新候选为 0.5.2/schema8：在 0.5.1 的执行桥上补充模型接口未上线时的明确文案与重试状态。0.5.1 独立部署包保持冻结。当前 DEV 已加载新前端，但 `/v1/models/catalog` 和 `/v1/admin/coze-models` 实际返回旧后台的默认 404；Pull 不会启动／升级独立账号服务。需要运行新后台后才能读取目录和保存模型配置，不能把静态预览正常当作业务可用。

本轮在现有 schema8 上增加 Coze 执行桥，无新增数据库迁移。源码完成不等于已接通生产模型；没有自动写入模型配置或真实调用。现有 Android v41 可沿用相同模型接口，无需把项目令牌或桥密钥放进 APK。

上线准备顺序：

1. 将新提交 Pull 到既有 Coze `new float ai` 项目，重启 DEV 预览。`.coze` 固定项目 ID，运行时应提供同项目 `COZE_PROJECT_ID`、`COZE_PROJECT_ENV` 和平台项目授权。SDK 不回退成个人 PAT 的直接 API 模式。
2. 先验证 DEV 只读模型目录；使用既有服务器 `/etc/tiyu/edge.env` 中的网关 Key 在内存签名，可运行工具 `tools/ssh-control/configure-coze-models.mjs --dev --check`。它只读目录，不生成答案、不更改环境／账户／模型数据。不应在本地造平台凭据冒充 Coze 运行时。
3. 经用户明确授权部署 Coze 后，确认固定生产源 `https://d635c6m6jj.coze.site` 的元数据与项目和 PROD 环境一致。执行 `configure-coze-models.mjs --check` 只读检查；`--write` 只会新建 `/etc/tiyu/coze-models.env`（0600），拒绝覆盖现有文件，不自动重启服务。
4. 备份现有数据库、部署配套账号服务和网页，并让服务读取上述环境文件。需要 `COZE_LLM_ORIGIN`、`COZE_LLM_ENVIRONMENT=PROD` 和服务端桥密钥；个人供应商 Key 和 `MODEL_MASTER_KEY` 不用于 Coze 执行。官方 API／BYOK 模式仍沿原配置。
5. 管理页选择“Coze 内置集成”，读取真实型号，绑定 1／2 点产品档位，核对实际名称。保存后明确点“发送一次测试”；它可能消耗已有 Coze 资源，不扣普通用户点数。实际通过再启用，不自动开通全部型号、不充值资源。

桥配置中的 DEV／PROD 必须与实际模型路由响应环境一致。现有 Coze DEV 和 PROD 网页共用一个独立账号后台，该后台只配置正式 PROD 执行桥；`--dev --check` 仅独立读取 DEV 目录，不切换主服务环境。当前没有独立 DEV 业务数据库或账号服务，不能声称两套业务已隔离。桥只接受已核对的固定生产主机或 UUID.dev.coze.site 预览主机，不支持任意 URL、重定向或客户端自带地址。详细协议与 SDK 超时／输出预算限制见 [Coze 模型执行协议](../../contracts/points-models-v1.md#coze-项目内置模型执行2026-10-01)。

以下为已有 0.5.0 候选说明；实际产物和未完成步骤以项目现状为准。

2026-10-01 当前本地候选为 **0.5.0 / SQLite schema8**，配套 Android v41。新包包含点数权限、模型目录与 AI 幂等结算、个人头像／昵称、题卡复审与新版网页。生产尚未升级，仍以 `docs/CURRENT_STATE.md` 记录为准。

## 本轮上线顺序与配置

- 备份现有数据库及运行配置，先部署新服务与网页，再发布 v41。schema8 新增用户头像、模型目录绑定及 AI 请求回执；从 schema5 顺序迁移，保留真实账号、点数、题库，不自动改余额或充值。
- 回退需停新服务，从升级前备份恢复到独立目录；不能把 schema8 数据库直接交给旧服务运行。
- 沿用现有 HTTPS 网关、会话与密钥配置；网关需转发 `Idempotency-Key`，模型调用路由须容纳完整响应时间。凭据由部署环境提供，不写包内文件。
- 内置模型默认不会自动启用。管理员在模型配置中绑定 9 个产品目录槽位，填写该账号真实可用的供应商模型 ID、有效 Key，测试通过后启用；须配置有效的 `MODEL_MASTER_KEY`，否则目录明确不可用。显示名不能当作供应商 ID。
- 可用点数大于 0 才允许浮窗与导入；本地基础功能不扣点。内置调用先预占，成功才扣 1／2 点；失败释放。自带 Key 不扣平台点数，仍需正余额。
- `GET /v1/ai/receipt` 以同一幂等键找回结果，不重新调用供应商，零点也可取回已完成答案。Key 不进入数据库或日志。现有部署仍为单实例 SQLite WAL。
- 代码构建和语法解析已完成，不等于上线或真机验收；本轮没有执行真实计费、生产库迁移、部署或手机安装。

网站目前支持真实文本文件／文本型 PDF 导入、题卡复审、资料保存和模型调用。图片 OCR／扫描 PDF、云端三级目录、跨库模糊检索和跨设备历史同步尚未在网站实现；界面明确提示对应边界。兑换与客服通道须后续接入真实业务。

详情：[点数与模型接口](../../contracts/points-models-v1.md)、[本轮后端记录](../../docs/validation/points-backend-2026-10-01.md)。

以下 M7 说明保留作历史候选。

当前本地候选为服务端 0.4.3 / SQLite schema7，新增本人私人题库名称和简介编辑；M6 的删除私库与导入日期也包含在此包中。生产仍为 0.4.1/schema5，首次升级依次新增 `banks.deleted_at` 与 `banks.description`。升级前须备份生产库；schema7 不能直接交给旧服务启动，回退必须使用升级前备份恢复到独立路径。当前源码仅本地准备，未部署生产。

以下 M6 说明保留作历史候选。

当前本地候选为服务端 0.4.2 / SQLite schema6，新增仅本人私人题库删除与目录真实导入时间。部署前须用现有在线备份机制保存 schema5 生产库；首次启动只新增 `banks.deleted_at`，已发布公共快照保留。schema6 数据库不能交给旧 0.4.1/schema5 服务直接启动；回退需停止新服务并从升级前备份恢复到独立路径。当前源码仅本地准备，未部署生产。

以下 M5.1 说明保留作既有运行基线。

M5.1 历史源码包版本为0.4.1，当时服务端SQLite为schema5；M5.1增加公共Android客户端更新元数据和固定4MiB分片下载。M5的0.4.0包继续冻结；M5.1使用独立发布包和`artifacts/m5.1/`证据。

## Android客户端更新发布目录

`APP_UPDATE_DIRECTORY`可选，建议生产设为`/var/lib/tiyu/app-updates`并挂载到服务容器。未配置、目录不存在或尚无`latest.json`时，`GET /v1/app-updates/android/latest`正常返回`not_published`；已有latest后的清单、APK或权限损坏返回503，不会伪装成未发布。HTTP只提供匿名只读latest和固定同源分片，没有APK上传、任意文件下载、外部URL或重定向。

运维工具必须调用Android SDK的`aapt`及`apksigner`（Windows通过`JAVA_HOME/bin/java -jar apksigner.jar`），不接受调用者自报包名、版本或签名。发布前先检查可信本地APK：

```sh
npm run app-update -- inspect --apk /trusted/floating.apk
npm run app-update -- prepare --directory /staging/app-updates --apk /trusted/floating.apk --notes-file /trusted/release-notes.txt
# 将完整 releases/<releaseId>/ 复制到生产配置目录并保持原文件名后，在服务器校验整体SHA、清单和版本递增并原子切latest：
npm run app-update -- activate --directory /var/lib/tiyu/app-updates --release-id <64位小写APK-SHA256>
# 同机准备并立即发布时可使用publish代替prepare+activate。
```

prepare先完整校验并写临时目录，再原子改名为不可变`releases/<releaseId>`；activate在独占`.activate.lock`内重新读取current、校验APK整体SHA、严格manifest、全部分片哈希及versionCode递增，最后原子替换`latest.json`，并发发布不能让版本倒退。正常失败会清锁；进程崩溃遗留锁时后续激活明确失败，不自动夺锁，运维须先确认没有发布进程、核对latest及候选完整性，再人工移除锁。APK限制1..96MiB，最多24片；除末片外每片固定4MiB。历史release必须保留，避免切换latest破坏进行中的下载。发布目录不放进代码ZIP、public、数据库备份或Git；APK签名密钥不进入服务器。

本服务已有真实身份会话、私有导入、审核发布、授权同步与管理接口；当前仅在本机合成环境验证，**未部署公网**。唯一产品APK由floating-app构建。Coze项目由主控管理，本服务未自行上传或改动Coze项目。

## 运行基线

Node.js 24（本机24.19.0），单实例SQLite WAL，独立持久化磁盘。密码scrypt N=131072/r=8/p=1，最多2个并发校验，每个maxmem192MiB；文件解析另使用最多2个256MiB worker，建议服务预留至少2GiB内存并设置操作系统/容器限制。不是多实例或大规模容量实测。

```sh
npm ci --omit=dev --ignore-scripts --no-fund
node --env-file=/secure/path/bank.env src/main.js
```

默认只监听127.0.0.1:8787。生产必须由配置正确证书的HTTPS反向代理接入，并只将应用端口暴露在受限网络；非loopback监听要求显式BEHIND_HTTPS_PROXY=true。不要公网裸HTTP，不用trust-all证书，不启用通配CORS。当前应用仅信任本机127.0.0.1/::1反向代理的转发IP；容器代理的不同地址需部署时明确审定，不得随意改为trustProxy=true。

Dockerfile仅包含src/public和锁定依赖，不包含test、运行时合成账号、数据库、密钥或artifacts。将/app/data挂载持久卷并以node用户权限可写。Dockerfile已准备，当前尚未执行Linux容器构建验收。

`GET /health`只返回状态和schema版本，不泄露账户、数据库路径或密钥。日志不包含请求体、密码、令牌或原件；客户端API使用Bearer头、Cache-Control:no-store和同源地址。

## 注册与管理员初始化

生产注册必须真实验证码，不存在默认管理员密码、首位用户自动管理员、万能码或生产fake开关。未配置短信时registration-code/register明确SMS_NOT_CONFIGURED。

短信适配器保留可选阿里云官方SDK：配置SMS_PROVIDER=aliyun、已审核签名/验证码模板、最小RAM发送权限及环境凭据；模板参数名为code，其他模板需适配后再用。服务只发送大陆手机号，HTTPS官方SendSms，不自动重试发送。SMS_HMAC_KEY为独立至少32字节熵的环境密钥，用于此模式的验证码摘要，验证码不写日志。

手机号规范为+86加11位；新注册、登录内改密和短信重设的新密码均不trim、不截断，须为6–64字符，确认字段必须完全一致。登录仍接受1–128字符并完整校验，以兼容旧版已创建的65–128字符密码。验证码6位、5分钟、一次性，5次错误后限制；手机号60秒冷却、小时5次/日10次，IP小时20次、服务小时100次。发送预算为当前可配置实现基线，不保证防住全部滥用。注册事务唯一手机号、消费challenge、赠送10点流水、固定15分钟试用及会话一起提交。

### 密码找回

`POST /v1/auth/password-reset-code`只为已注册、已验证且当前通道可恢复的手机号发送验证码；不存在或没有可信恢复绑定返回`RECOVERY_UNAVAILABLE`，禁用账号返回`ACCOUNT_DISABLED`。`POST /v1/auth/reset-password`要求手机号、专用challenge、6位验证码及两次一致的6–64字符新密码，成功204且不创建会话。

注册和重设challenge分别标记`registration`与`password_reset`，同时绑定手机号、provider、issuer和重设目标用户；两种用途共享手机号/IP/全局发送预算与失败预算，不能交叉消费。成功重设在单个事务中消费challenge、更新scrypt哈希、撤销该用户全部会话并审计，不改变角色、会员、点数、试用、注册时间或题库。登录密码错误时，仅当服务器确认该账号可通过当前通道恢复，错误对象才带`recoveryAvailable:true`。

### 可选Supabase手机号证明

配置`SMS_PROVIDER=supabase`、固定HTTPS项目根URL `SUPABASE_URL` 和 `SUPABASE_PUBLISHABLE_KEY`；历史anon key可用`SUPABASE_ANON_KEY`作为后备，拒绝secret/service_role。配置只在服务端读取，不提供浏览器配置接口。需要项目已启用Phone Auth并连接真实SMS供应商；这些项目配置未在本轮验证。缺少/无效配置返回503 SMS_NOT_CONFIGURED，上游拒绝/不可达返回SMS_UNAVAILABLE，不假报发送成功。

锁定官方SDK调用signInWithOtp(phone, SMS)→verifyOtp(phone, token, sms)→getUser(access_token)。注册发码使用`shouldCreateUser:true`，密码重设发码使用`shouldCreateUser:false`，不得借找回流程创建上游账号。短信OTP由上游产生和校验，本地不保存OTP/上游token；只绑定固定项目issuer和可信getUser.id，要求已确认手机号与请求一致。重设还要求该issuer/subject/手机号已绑定同一本地用户，不新增或改绑身份。角色、点数、会员不取上游metadata。仅可信provider返回处兼容11位、86和+86号码，本地API输入规则不变。每次上游操作独立SDK实例，关闭持久化/自动刷新/URL会话解析并dispose；获取的上游会话只短暂用于getUser，不转发客户端或保存到DB，不使用上游密码接口。成功注册仍设置题屿scrypt密码，后续手机号密码登录完全由题屿服务完成。

外连固定到配置origin的otp/verify/user路径，拒绝跳转和其他路径；每次SDK操作共享8秒超时，响应上限64KiB，同一操作禁止自动重试。发送和校验预算先落库；验证原子占用challenge，同手机号验证中拒绝新码/并发验证。新码使旧challenge失效，provider/issuer切换使旧挑战永久失效；本地上限5分钟，上游若更早到期，以更短期限为准。Supabase项目应配置为与6位/5分钟要求相容；供应商控制台的实际OTP期限及费用限制必须部署时核实。

校验完成产生仅当前请求可用的内部proof，在同一本地事务中消耗并写入issuer/subject唯一绑定、手机号唯一用户、一次10点流水、固定15分钟试用和业务会话。现有手机号绝不自动绑定或覆盖密码；同issuer/subject也不能注册另一个本地账号。上游结果不确定、进程中断或本地提交失败均需重新取码，不缓存可复用证明。上游可能已消费OTP或已创建Auth用户但本地仍未注册；新码可重试注册，不自动删除或修改上游用户。

当前仅完成实际SDK＋合成HTTP传输测试，没有真实URL/key/SMS。Coze附件为其他对话的示例，且注明获取Auth配置失败；是否对独立后端开放同协议、是否要求x-session/平台代理/验证码挑战仍未知。此适配器不探测或绕过Coze身份边界。若上游要求CAPTCHA，现有v1无captchaToken字段，将明确失败；需主控先批准客户端合同扩展，不能关闭验证码保护来冒充接通。

首次管理员先通过真实注册流程创建本人账号，再由有服务器权限的操作者执行：

```sh
BANK_DATABASE=/persistent/bank.sqlite npm run admin -- grant +8613800000000
# 如果明确同时赋予长期赞助身份，再加 --sponsor；角色本身不绕过会员。
```

上述号码仅格式示例，应替换为实际已注册号码。命令没有密码参数，权限变更撤销旧会话并审计。管理员页面可调整会员/点数、禁用、强退、查看全部已同步导入、审核具体私版、发布/撤回、配置模型与公告。普通私库保存不公开，发布生成独立不可变public版本。

## 会话、会员和模型

access 15分钟；refresh单次轮换、sessionId稳定、会话绝对30天，复用旧refresh撤销家族。登录/改密/上传异步阶段后重新核会话或账户状态，防止处理中封禁仍提交。身份离线最多7天；查询功能许可另最多15分钟，宿主每60秒及回前台/me续验，依据serverTime与单调时钟，free到期仍可导入/更新但不能查答案。

模型Key使用MODEL_MASTER_KEY（32字节base64）AES-256-GCM加密，缺主密钥拒绝保存。主密钥与DB备份分开保管，轮换前需受控解密重加密迁移，不能直接丢弃旧密钥。返回仅指纹/配置状态，从不返回明文Key。当前白名单仅DeepSeek官方源和豆包北京/v3；text测试固定非私人文字、小输出、关闭thinking且不重试，只有非空stop完成和有效usage才通过。不支持的thinking配置将明确失败，不能通过重复试探冒充成功。变更Key/model/baseURL等后旧测试失效。

模型测试会产生小额供应商调用费用，需管理员明确点击；当前没有真实供应商Key，因此只完成模拟transport测试，**没有实网模型可用结论**。本地检索不上传模型、不扣点；用户AI入口及真正预留/结算请求尚未实施，点数账本与管理员调整已实现。pending/uncertain测试不自动重试，相同幂等键只返回原尝试状态，需对照供应商控制台核对。启动时发现上次进程留下的pending会记为uncertain/PROCESS_INTERRUPTED并审计，不再次调用供应商，也不标为可用。

## 文件与容量预算

原件作为私有SQLite BLOB保存，不放public静态目录。单文件10MiB，解析worker最多20秒；压缩包最多2000项/解压声明总64MiB并拒绝危险路径及加密；文本2MiB，PDF200页，单任务预览10000题。目录512KiB、单包32MiB；Android单次同步总64MiB。超额明确错误，不截断冒充完整清单，这些是单任务预算而非产品总题数上限。

CSV/TSV/JSON/JSONL/TXT/XLSX/DOCX/文本PDF已用独立合成资料测试。DOCX另支持带声明题数的单选/多选/判断章节、数字题号、Word自动编号、同段嵌入题号、分行或连续选项及明确答案；章节声明数量不能完整还原时拒绝预览并报告位置。TXT和非章节DOCX/PDF仍须规则题型/题干/答案标签或明确题边界；Word段落及简答空行保留。公式单元格不执行、标错待人工更正；图片、扫描PDF、旧DOC/XLS、复杂多栏、数学图形自动理解未支持。解析警告与原件可下载，缺答案或选项不会生成内容或伪造完整性。

## 备份和恢复

```sh
BANK_DATABASE=/persistent/bank.sqlite npm run backup -- /protected/backups/bank-2026-09-27.sqlite
```

使用Node SQLite一致性backup API，目标必须不存在；不要在运行中只拷贝主db而漏掉WAL。备份含手机号、私题、原件、密文Key和令牌摘要，应限制读权限、加密离线备份并设置留存。环境SMS/MODEL密钥另做受控备份；备份文件不能放网站根目录。

恢复先停止本服务，核对目标目录与备份哈希，在新的数据库路径复制备份，再用该BANK_DATABASE启动；保存原库以便回退。核对health/schema、本人题库/版本/原件及管理员权限，再恢复流量。不要跨多实例同时写同一SQLite。迁移由user_version事务执行（当前5），高于代码支持的版本拒绝启动并关闭句柄。schema4→5只为短信challenge新增用途、目标用户及索引，不改用户、会话、身份绑定、积分或题库；升级前先用在线backup留schema4备份。旧M3代码不能打开schema5库，回退必须停止新服务并从升级前备份恢复到新路径，不能直接改user_version降级。

## 测试与部署验收

`npm test`运行Node测试；test/live-harness.js是仅loopback的独立合成DB/注入短信夹具，绝不能作为生产入口。它提供`GET /__test/sms-code/:username`读取刚发送的合成验证码，供网页或Android联调找回流程；该路由只存在于test脚本，不进入`src`、Docker镜像或部署包。受控凭据仅在artifacts/m2/runtime临时文件，未写入APK或部署包。真机仅浮窗任务操作92f9bcb9，通过8788映射测试真实登录、上传、目录和下载；这不等于云端上线。

部署前须在用户指定环境验证：HTTPS证书、真实短信签名/模板/凭据或正式外部身份映射、持久盘与备份恢复、管理员初始化、真实模型Key（若配置测试）、流量/短信费用限额。未完成项在STATUS记录，不用本地fixture替代生产验收。

M5.1部署包使用`./package-deployment.ps1 -Version m5-1-app-update-release -Milestone m5.1`生成在`question-bank/artifacts/m5.1/`；目录参数支持m2/m3/m4/m5/m5.1，既有同名包拒绝覆盖。包不含测试、APK、原始DOCX、运行数据库、node_modules、发布目录或artifacts；历史包及其证据保持冻结。

Supabase依据：[发送OTP](https://supabase.com/docs/reference/javascript/auth-signinwithotp)、[校验OTP](https://supabase.com/docs/reference/javascript/auth-verifyotp)、[可信getUser](https://supabase.com/docs/reference/javascript/auth-getuser)、[Phone Auth及SMS配置](https://supabase.com/docs/guides/auth/phone-login)、[手机号密码能力](https://supabase.com/docs/guides/auth/passwords)、[Publishable/anon Key](https://supabase.com/docs/guides/getting-started/api-keys)。

技术依据：[Node SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)、[Fastify](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)、[阿里云SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)、[DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)、[豆包](https://docs.volcengine.com/docs/ark/chat-api?lang=en)。
