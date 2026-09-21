# SScode Android 客户端

面向个人开发者的远程 AI 编程 App：经 SSH 连接自有 Linux 服务器，通过隧道访问服务器上的 sscode-server 配套服务。

当前状态：P3 前半部分实现完成（服务器管理、SSH、环境检测、一键部署、项目列表、简化 AI 工作区），debug 包构建通过；SSHJ 关键链路（私钥认证/主机指纹/端口转发）已经桌面 harness 对真实服务器实测。**未做真机验证**；文件/终端/Git/完整 IDE 为后续阶段。

## 构建

2026-09-19：Android 15 模拟器已验证 SSH 认证、远程命令、环境检测、本地隧道及已有服务授权。服务器已部署但 App 尚无 token 时，点击详情页“连接已有服务”后进入项目。实体手机仍待验证。

可选远端集成测试：构建并安装 debug APK 和 androidTest APK 后执行 `adb shell am instrument -w -e serverId 1 -e class dev.sscode.app.ssh.SshConnectionTest dev.sscode.app.debug.test/androidx.test.runner.AndroidJUnitRunner`。serverId 指 App 内已配置且已记录指纹的测试服务器；不传则跳过。

工具链已固定在仓库 `tools/`（JDK 17 + Android SDK + Gradle 8.10），无需系统安装：

```bash
cd android
./build-debug.sh        # 产出 app/build/outputs/apk/debug/app-debug.apk
```

服务端载荷更新后重新打包 assets：

```bash
./package-server-asset.sh   # ../server → app/src/main/assets/sscode-server.tar.gz
```

## 功能与代码结构（`app/src/main/java/dev/sscode/app/`）

| 模块 | 内容 |
|---|---|
| `data/` | Room 服务器配置；EncryptedSharedPreferences 凭据库（密码/私钥/API token，PEM 不落库） |
| `ssh/` | SSHJ 封装：密码/私钥（含口令）认证、主机指纹 TOFU + 变化阻断、exec/SFTP/本地端口转发 |
| `deploy/` | 环境只读检测（EnvReport）；六阶段幂等部署（npmmirror 装 Node → 上传载荷 → systemd 用户服务 → health → 取 token） |
| `api/` | sscode-server REST 客户端（OkHttp + kotlinx.serialization，宽松解析） |
| `ui/` | 服务器列表/编辑/详情（检测+部署）、项目列表、简化 AI 工作区（任务提交/轮询/审批）；中英双语、深浅主题跟随系统 |

## 使用前提

- 服务器：可 SSH 的 Linux（已验证 Ubuntu 22.04 x86_64）；App 内一键部署会在服务器用户目录安装 Node 与 sscode-server（systemd 用户服务，仅监听 127.0.0.1，无需 sudo）。
- 模型：部署后到服务器配置模型（当前版本 Key 录入需经 API/服务器侧，App 内模型配置界面属 P5）。

## 已知限制

- 未做真机验证（触控、WebView、生命周期）；加密私钥口令链路需真机复测（bcprov 依赖已含）。
- "保存凭据"关闭时连接会提示未保存凭据（本次会话内存持有凭据的功能未做）。
- 部署阶段文案部分为硬编码中文，未完全走资源。
