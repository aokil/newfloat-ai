# GitHub Release 软件更新 v2

2026-09-28 用户选择公开 GitHub 仓库供 Android App 直接读取软件更新，并要求每个版本只发布一个 APK。题库数据更新仍走题屿服务。

## 发布入口

- 固定仓库：`aokil/newfloat-ai`。Release 标签为 `android-v<versionCode>`，非草稿、非预发布；latest Release 专用于 Android 软件更新。
- 每个新 Release 包含 `tiyu-update.json` 和一个 `tiyu-<APK SHA-256>.apk`。客户端启动时读取 `https://github.com/aokil/newfloat-ai/releases/latest/download/tiyu-update.json`；用户点“立即更新”后才下载 APK。
- 清单沿用 v1 的 `status: available`、`release` 元数据、包名、版本、minSdk、签名与 SHA-256 字段。为兼容既有解析器，`parts` 仅含一项，`index=0`、`sizeBytes=APK大小`、`sha256=整包SHA-256`，`path` 固定为 `https://github.com/aokil/newfloat-ai/releases/download/android-v<versionCode>/tiyu-<releaseId>.apk`。
- GitHub 下载可能跳转。客户端只接受 HTTPS、无用户信息、无显式端口、最多 5 次跳转，目标限定为该仓库的 GitHub Release 路径或 `*.githubusercontent.com`。请求不携带产品账号凭据。APK 流式写入 App 私有缓存，限制最大 96 MiB；写完校验长度和 SHA-256，再检查包名、递增版本、系统兼容和当前签名，最后交给 Android 系统安装。
- v15 曾使用 4 MiB 分片，现保留为历史 Release；v16 起采用单 APK。v16 客户端仍可解析旧分片清单，但桌面发布工具只生成单 APK。

## 桌面发布

在 `floating-app/app/build.gradle.kts` 递增 `versionCode`，完成代码和发布说明后，运行 `tools/github-updates/publish-from-desktop.ps1 -NotesFile <说明文件>`。脚本本地构建 APK、冻结独立版本产物、生成清单；发布工具先创建 GitHub 草稿 Release，上传 APK 与清单后公开 Release。凭据使用当前进程的 `GH_TOKEN`/`GITHUB_TOKEN` 或本机 Git Credential Manager，不写入源码、参数和日志。

仅同步 Git 提交不会产生 APK Release。工作区根目录没有 Git 仓库，`coze-app/newfloat-ai` 只含 Coze 网关源码，因此 GitHub Desktop 对该仓库的普通同步无法构建 Android APK。桌面发布脚本才是 APK 发布入口。新版本在手机下一次启动检查时提示，不会在 GitHub 发布瞬间推送给已运行的 App。

## 首次迁移

手机已知安装 v13，只检查原题屿服务器；2026-09-28 只读查询旧服务器 latest 为 v14。v16 已在 GitHub 发布，未发布到旧服务器，也未安装到手机。用户质疑服务器登录用途后，已停止服务器操作。首次进入 GitHub 更新通道需手动安装一次同包名、同签名的 v16 APK；之后才由 App 启动检查 GitHub Release。此前手机验收暂停仍有效，不因远端 Release 发布自动操作设备。
