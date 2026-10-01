# App 自身更新 v1（M5.1）

2026-09-27主控冻结，随后按用户要求更新启动提醒交互。用户要求软件内唤起更新；与“更新题库”分开。首个含此能力的v13仍需一次同签名覆盖安装，之后启动时后台静默检查，有新版才提示下载并唤起系统安装确认。App不伪装静默安装、不自动开启未知来源安装许可；原账号/题库通过同包同签名安装保留，不清应用数据。

## 入口与状态

使用既有固定正式HTTPS源，不增加服务地址设置，也不在“我的”显示更新入口。不要求登录即可检查公共客户端版本，下载不携带用户token/cookie。MainActivity启动UI稳定后后台单飞检查，每进程启动一次；无新版、未发布或检查失败保持静默，内部保留真实状态，不能把失败认作已最新。有新版时只在Main前台可交互且无导入/编辑/截图授权或其他弹窗时展示；否则延后，不抢焦点或从后台拉前台。这里“推送”指启动检查发现新版后的应用内提醒，不增加第三方推送SDK、设备token或后台常驻。

更新弹窗沿既有题屿设计，显示目标版本、简短更新说明和大小；动作“立即更新”和“稍后”。稍后将同一versionCode抑制24小时，更新的versionCode不受旧抑制影响；时钟回拨不能无限延长抑制。长说明可滚动，所有动作48dp，不被系统栏/窄屏/大字体遮挡。用户点立即更新后才下载，显示进度和取消。失败给重试/稍后，APK验证成功后显示“安装新版”，由用户触发系统安装。权限未允许时用户自行进入Android对应授权页后返回；不通过ADB自动授权。仅优化App自己的更新弹层，不仿造或修改系统安装确认界面。

区分正在检查、已是最新版、尚未发布版本、检查失败、下载中、已取消、校验失败、准备安装和已交给系统；不能从启动安装界面推断安装成功。复开时显示PackageManager/BuildConfig的实际已安装版本。安装取消可重新安装已验证包；失败可重试，不能降级。检查/下载不干扰截图/个人导入，不主动把后台App切前台。

## HTTP（公共只读，无新数据库表）

`GET /v1/app-updates/android/latest`返回200：

未配置运维发布目录或目录中尚无latest：`{"status":"not_published"}`。

已发布返回：

```json
{
  "status": "available",
  "release": {
    "releaseId": "<64位小写APK-SHA256>",
    "packageName": "com.newfloat.floating",
    "versionCode": 13,
    "versionName": "0.7.1-tiyu-m5.1",
    "minSdk": 26,
    "sizeBytes": 48000000,
    "sha256": "<64位小写APK-SHA256>",
    "signerSha256": "<64位小写签名证书SHA256>",
    "publishedAt": "2026-09-27T12:00:00.000Z",
    "notes": "新增软件内更新。",
    "parts": [
      {"index":0,"sizeBytes":4194304,"sha256":"<64位小写分片SHA256>","path":"/v1/app-updates/android/packages/<releaseId>/parts/0"}
    ]
  }
}
```

示例size只作字段说明，不是实际APK大小。完整parts从0连续，除末片外固定4MiB，末片1..4MiB，总size相等；总APK范围1..96MiB、最多24片，JSON最多32KiB。versionCode正整数、versionName1..128、notes最多2000字符、minSdk正整数且Android客户端判兼容，packageName固定。releaseId必须等于sha256；所有散列64位小写hex。

`GET /v1/app-updates/android/packages/:releaseId/parts/:index`返回200二进制分片，`Content-Type:application/octet-stream`及准确Content-Length，不使用重定向和外部地址；已发布历史版本分片继续可读，以免下载中途切latest破坏一致性。客户端固定使用同源路径，只接受上述严格路径和匹配releaseId/index。服务端从配置目录的不可变发布内容读取，无通用文件下载/路径参数/上传API。错误沿既有API规范：未找到404，损坏/读取失败503；无论何种故障不得降为not_published。生产目录权限问题同样报失败。

4MiB分片用于适配既有Coze32MiB单响应预算，不扩大网关限制或改变题库包格式。逐片串行下载，每片校验大小/SHA；总量不超过声明和预算，取消/网络/校验失败不送安装器。首次实现可从零重试，不要求断点续传。

## 安卓安装验证

客户端下载到本App私有cache子目录，禁止任意外部目标文件及任意下载URL，HTTPS仅系统可信证书；禁跨源或任何重定向。下载完成核对整个文件size/SHA256，再通过PackageManager检查可解析APK、包名与当前App一致、versionCode与清单一致并大于当前、minSdk可用、签名证书与当前已安装App一致且与清单相符。任何不符拒绝安装。保持当前单签名部署，暂不引入签名轮换协议。

只通过受控PackageInstaller或窄路径且不导出的FileProvider给系统安装器临时读权限，不开放整个cache/files目录或任意外部文件。仅在用户点安装时申请所需系统安装授权；此权限不能用于后台静默安装。APK及清单不含账号token、用户数据或服务端秘密。

## 发布和测试

服务端新增可选`APP_UPDATE_DIRECTORY`（部署建议`/var/lib/tiyu/app-updates`）。发布工具仅由运维本地/SSH调用，读取已构建并通过aapt/apksigner验证的APK，生成上述元数据/分片hash及不可变版本目录后原子替换latest。版本必须递增，拒绝覆盖已发布版本，不在生产代码仓库提交APK或密钥。可以保留原APK并按索引读文件片段；先完整校验/落盘，再暴露latest，防止半发布。部署复制整个候选版本后先校验APK和manifest再原子发布。

M5已冻结0.4.0/v12产物不覆盖。本轮后端0.4.1/schema5、安卓versionCode13/versionName0.7.1-tiyu-m5.1，独立artifacts/m5.1。合成测试覆盖not_published、发布/读取/分片拼回、错误路径、缺片/损坏、非递增版本；客户端覆盖版本判断、大小/hash/path/签名/包名拒绝、取消与失败保留当前安装。构建、安装器唤起与最终安装成功分别记录；未操作实际设备或尚未上线时不能称自动更新已接通。
