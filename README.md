# SSCode：用手机连接本地 Windows 电脑

SSCode 是 Android 远程编程 App。手机通过 SSH 连接你的电脑，在手机上使用 AI 编程、浏览和编辑文件、执行终端命令、操作 Git。

本文适用于 **SSCode 0.2.4、Windows 10/11、Android 8.0 及以上**。示例把本项目放在 `E:\SSCode`，请替换为你的实际目录。首次配置建议预留 20～30 分钟。

## 1. 先了解需要安装什么

| 位置 | 软件 | 用途 |
|---|---|---|
| 手机 | SSCode APK | 操作项目、文件、终端和 AI |
| 电脑 | OpenSSH Server | 接收手机连接，验证密码或私钥 |
| 电脑 | Node.js 22.18+ | 运行 SSCode 配套服务；建议使用受支持的 LTS 版本 |
| 电脑 | Git for Windows | 使用 Git 功能，也供 AI 执行 Git 命令 |
| 手机和电脑 | Tailscale（推荐） | 跨校园网、热点和移动网络连接 |
| 电脑 | WSL + code-server（可选） | 使用完整 VS Code 网页 IDE |

连接结构：

```text
手机 SSCode
  └─ SSH → Windows 电脑 TCP 22
       └─ 加密隧道 → 电脑 127.0.0.1:7823 的 sscode-server
```

**安装 APK 并不会自动给 Windows 安装配套服务。** 需要完成下面的电脑端配置。无需将 7823 端口开放到公网或局域网。

## 2. 选择连接方式

### 推荐：Tailscale，适合校园网及异地连接

同一校园 Wi-Fi 可能禁止设备互访，即使手机和电脑都能上网，也不一定能直接连接。Tailscale 会给两台设备分配虚拟网络地址，网络允许时直连，否则通过中继连接。

1. 在 [Tailscale 官网](https://tailscale.com/download) 下载 Windows 和 Android 客户端。
2. 手机和电脑登录同一账号，并开启连接。
3. 在设备列表中记下**电脑的 Tailscale IPv4 地址**和**手机的 Tailscale IPv4 地址**，通常是 `100.x.x.x`。
4. 手机 App 填电脑的地址；电脑防火墙规则填手机的地址。

电脑上也可执行：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" ip -4
& "$env:ProgramFiles\Tailscale\tailscale.exe" status
```

Tailscale 登录不等于 Windows SSH 登录。SSCode 仍使用 Windows 账户密码或私钥认证，不需要启用 Tailscale SSH 功能。自定义过 Tailscale 访问策略的用户，还需允许手机访问电脑 TCP 22。

### 可选：同一局域网或手机热点直连

手机和电脑连接允许设备互访的网络；也可以开启手机热点，让电脑连接它。在电脑 PowerShell 中查看：

```powershell
Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object InterfaceAlias,
        @{Name='电脑IPv4';Expression={$_.IPv4Address.IPAddress}},
        @{Name='网关';Expression={$_.IPv4DefaultGateway.NextHop}}
```

在 App 中填电脑的 WLAN/以太网 IPv4。换 Wi-Fi 或热点后，地址可能改变，需要重新填写。

> `10.0.2.2` 仅供 Android 模拟器访问宿主电脑，实体手机不能使用。手机上的 `127.0.0.1` 指手机自身，也不能作为电脑地址。

## 3. 准备 Windows 账户和 SSH

### 3.1 确认登录用户名与密码

在电脑普通 PowerShell 中执行：

```powershell
whoami
```

例如返回 `my-pc\alice`，App 用户名通常填写 `alice`。域账户或 Microsoft 账户若认证失败，先在电脑上验证可用的 SSH 登录名；不要直接把 Windows 显示昵称当作用户名。

- **密码认证**使用该 Windows 账户的登录密码。
- Windows Hello **PIN、指纹、人脸不是 SSH 密码**。
- **私钥认证**需要对应的私钥；“私钥口令”是生成私钥时设置的口令，不是 Windows 密码。
- 没有账户密码、只使用 Windows Hello 的用户，建议配置私钥；也可以在 Windows 账户设置中先建立可用于密码认证的账户。不要为教程操作去修改其他人的账户密码。

### 3.2 安装并启用 OpenSSH Server

在开始菜单搜索 PowerShell，右键选择**以管理员身份运行**。以下安装、服务管理、防火墙命令都在管理员窗口执行。

```powershell
Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

如果 `State` 不是 `Installed`，执行：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

安装需要联网；如果系统要求重启，重启后继续。也可从 Windows“可选功能”中添加 **OpenSSH 服务器**，仅安装“OpenSSH 客户端”不够。

启动 SSH 并设置开机自动启动：

```powershell
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd | Select-Object Name,Status,StartType
Get-NetTCPConnection -State Listen -LocalPort 22
```

预期看到 `Running`、`Automatic`，且 22 端口在监听。

如果 `sshd.exe` 已存在，但提示找不到 `sshd` 服务，可使用本项目的恢复脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\SSCode\server\scripts\repair-windows-ssh.ps1"
```

该脚本适用于 Windows 自带路径 `C:\Windows\System32\OpenSSH\sshd.exe`，会在服务缺失时重新注册并启动。若你安装的是其他目录的 OpenSSH，请按对应发行版安装说明注册服务，不要混用程序路径。

### 3.3 防火墙放行手机的 SSH 访问

Tailscale 方案：把下面示例地址换成**手机的 Tailscale IP**，再执行：

```powershell
$phoneIp = '100.100.100.100' # 必须替换为自己的手机地址
$sshProgram = 'C:\Windows\System32\OpenSSH\sshd.exe'

New-NetFirewallRule -DisplayName 'SSCode 手机 SSH' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
    -RemoteAddress $phoneIp -Program $sshProgram -Profile Any `
    -PolicyStore PersistentStore
```

局域网直连方案：`$phoneIp` 改为手机的局域网 IPv4；手机热点模式可核对电脑默认网关，它通常是手机的热点地址。

规则持久保存，重启后有效。`Profile Any` 适用于 Windows 把网络识别为“公用”或“专用”的情况，来源仍限制为指定手机。手机地址改变后，需要更新规则。

检查规则：

```powershell
Get-NetFirewallRule -DisplayName 'SSCode 手机 SSH' |
    Select-Object DisplayName,Enabled,Profile,Action
Get-NetFirewallRule -DisplayName 'SSCode 手机 SSH' |
    Get-NetFirewallAddressFilter |
    Select-Object RemoteAddress
```

如果你使用其他安装路径的 sshd，防火墙的 `-Program` 必须与实际程序一致：

```powershell
Get-CimInstance Win32_Service -Filter "Name='sshd'" |
    Select-Object PathName
```

### 3.4 先在电脑验证 SSH 登录

回到普通 PowerShell，用自己的用户名测试：

```powershell
ssh alice@127.0.0.1
```

首次连接会要求确认主机指纹；核对后输入 `yes`。输入密码时终端不显示字符是正常现象。登录成功后执行 `exit` 返回。

如果这里就认证失败，先解决 Windows 账户或 SSH 配置问题，再尝试手机。有关私钥配置，参见 [Microsoft：Windows OpenSSH 密钥管理](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)。普通用户与管理员用户的 `authorized_keys` 位置和 ACL 要求不同。

私钥认证使用流程：生成专用 Ed25519 密钥 → 将 `.pub` 公钥配置到电脑 SSH 授权文件 → 验证 SSH 登录 → 将不带 `.pub` 后缀的私钥安全传到自己的手机并导入。不要使用其他人的测试私钥，也不要把私钥提交到仓库。

## 4. 安装并启动 SSCode 配套服务

### 4.1 安装 Node.js 与 Git

从 [Node.js 官网](https://nodejs.org/) 和 [Git for Windows](https://gitforwindows.org/) 安装软件。安装完成后重新打开**普通 PowerShell**：

```powershell
node --version
git --version
```

Node 需要 **22.18 或以上**，用于原生 TypeScript 和 SQLite 支持。本项目服务端没有第三方运行时依赖，正常启动不需要 `npm install`；修改源码、运行类型检查时才需要开发依赖。

### 4.2 启动服务

获取本项目完整文件，确保包含 `server/src`、`server/package.json` 和 `server/scripts`。然后在你准备使用 SSH 登录的**同一个 Windows 用户**下运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "E:\SSCode\server\scripts\start-windows.ps1"
```

先保持该窗口开启；不要重复启动多个服务实例。再开一个 PowerShell 检查：

```powershell
Invoke-RestMethod http://127.0.0.1:7823/v1/health
```

预期包含：

```text
version         : 0.2.4
platform        : win32
terminalBackend : persist
```

数据保存在 `%USERPROFILE%\.sscode`，访问令牌位于该目录的 `auth-token` 文件中。App 会通过 SSH 自动读取令牌，通常不用手工复制。启动日志含有访问令牌，分享截图时不要暴露它。

Windows 配套服务应以普通用户运行，而不是 SYSTEM 或另一个管理员账户，否则数据目录和 App 经 SSH 读取令牌的目录可能不同。

### 4.3 可选：设置登录后自动启动配套服务

**SSH 开机自启与配套服务自启是两件事。** 只设置 sshd 自动启动，电脑重启后仍可能无法进入工作区。

下面在当前用户启动文件夹创建快捷方式，Windows 登录后后台启动配套服务，不需要保存账户密码。先确认上一节手工启动成功，再在普通 PowerShell 中执行：

```powershell
$startScript = 'E:\SSCode\server\scripts\start-windows.ps1'
if (-not (Test-Path -LiteralPath $startScript)) { throw '请先修改为正确的项目路径' }
$startupDir = [Environment]::GetFolderPath('Startup')
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut((Join-Path $startupDir 'SSCode Server.lnk'))
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $startScript + '"'
$shortcut.WorkingDirectory = Split-Path -Parent $startScript
$shortcut.WindowStyle = 7
$shortcut.Save()
```

这会在**用户登录后**启动，不是在无人登录时启动。不要同时配置多套自启方式。若此前已注册本项目的 `SScodeServer` 计划任务，保留一种即可；项目移动后需更新快捷方式。

下次重启登录后，用 `/v1/health` 确认服务运行。电脑应保持开机和网络连接；需要长时间远程使用时，在 Windows 电源设置中调整接电时的休眠策略。

## 5. 手机安装和首次连接

1. 将 [SSCode-0.2.4.apk](dist/SSCode-0.2.4.apk) 传到手机安装。若通过微信传输，可使用 [ZIP 包](dist/SSCode-0.2.4-wechat.zip)，解压后安装 APK。
2. 按 Android 提示允许当前文件管理器安装此 APK。当前产物为测试签名版本。
3. 使用 Tailscale 时，先确认手机和电脑都已连接 Tailscale。
4. 打开 SSCode，点击添加服务器。

| 字段 | 填写说明 |
|---|---|
| 名称 | 自定义，例如“我的电脑” |
| 主机地址 | 电脑的 Tailscale IP，或可直连的局域网 IPv4；不加 `http://` |
| 端口 | `22` |
| 用户名 | 第 3.1 节确认的 Windows 登录用户名 |
| 认证方式 | 密码或私钥 |
| 密码 | Windows 账户密码，不是 PIN |
| 私钥 | 选择私钥认证时导入对应的私钥文件，不是 `.pub` 文件 |
| 私钥口令 | 仅当私钥本身设置了口令时填写 |
| 保存凭据 | 当前版本建议开启，后续连接依赖保存的凭据 |

保存后点击“连接”。首次连接记录主机指纹；电脑管理员可用以下命令查看并核对：

```powershell
ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub
```

如读文件提示权限不足，请在管理员 PowerShell 中执行。重装 SSH 后指纹可能改变，先核对电脑当前指纹，再决定是否重新信任。

连接成功后：

1. 环境检测应显示 Windows、Node.js、Git 和 `sscode-server` 服务状态。
2. 首次点击 **“连接已有服务”**，App 获取并验证访问令牌。
3. 点击 **“进入项目”**。

Windows 走“本机启动服务 + App 连接已有服务”，无需使用针对 Linux 的环境部署流程。

### 5.1 设备绑定与会话（API Key 登录，多设备共享）

当前源码版本新增设备会话流程（0.2.4 发布包尚未包含，将随后续版本发布）：手机在“绑定模型”页面填写服务商、Base URL、模型 ID 和 API Key 提交绑定；服务器实测验证 Key 的连接与工具调用能力，通过后签发设备会话。此后手机只携带会话凭据，不再依赖静态访问令牌。

- **API Key 只保存在电脑端**：写入本机受保护存储（`%USERPROFILE%\.sscode\secrets.json`），不出现在任何接口响应、日志或事件中；手机上不保存 API Key。
- **首台绑定设备自动成为所有现有项目的 owner**；之后绑定的设备默认为 viewer（只读），由 owner 在“项目成员”页面提升为 operator/reviewer。
- **会话自动续期**：access token 15 分钟有效，过期后 App 自动用 refresh token（30 天有效，存 Android Keystore）换新，无需重新输入 Key；设备可在“设备会话”页面退出或被撤销，撤销立即生效。
- **旧流程继续可用**：经 SSH 自动读取静态令牌的“连接已有服务”方式在迁移窗口内保留；文件、Git、终端和完整 IDE 页面在窗口期内仍走旧令牌。细节见 [部署指南](docs/部署指南.md) 与 [隐私与威胁模型](docs/隐私与威胁模型.md)。

## 6. 创建项目并使用

### 6.1 准备一个试用目录

在电脑执行：

```powershell
New-Item -ItemType Directory -Force 'E:\Projects\sscode-demo'
git -C 'E:\Projects\sscode-demo' init
git -C 'E:\Projects\sscode-demo' config user.name 'Your Name'
git -C 'E:\Projects\sscode-demo' config user.email 'you@example.com'
```

Git 初始化与身份设置仅用于需要 Git 的项目。在 App 项目列表中点击“新建项目”，填写名称和电脑上的完整目录路径，例如 `E:/Projects/sscode-demo`。

路径指的是**电脑上的目录**，不是手机存储路径。初次试用建议使用独立目录。

### 6.2 文件、终端与 Git

- **文件**：浏览、创建、编辑、保存、重命名、移动和删除。保存冲突表示电脑上的文件已被其他操作修改，先检查差异。
- **终端**：Windows 使用 PowerShell 优先的持久进程。可执行 `Get-Location`、`Get-ChildItem` 等命令。
- **Git**：查看状态和差异、暂存、提交、切换分支、拉取和推送。远端仓库凭据需在电脑端配置。

Windows 终端支持断开后恢复，但前提是配套服务进程仍在运行；服务重启后终端会话丢失。当前后端不支持 vim、htop 等需要完整 PTY 的全屏交互程序。

### 6.3 配置 AI 智能体

在工作区点击模型/智能体选择入口，进入“智能体配置”，新增：

| 字段 | 说明 |
|---|---|
| 名称 | 便于识别的名称 |
| API 基础地址 | 服务商提供的兼容地址，通常以 `/v1` 结尾 |
| 模型 ID | 服务商支持且你的账号有权限使用的模型 |
| API Key | 与该地址、套餐匹配的密钥 |

点击“测试”，通过后选择该智能体。模型需支持工具调用。电脑必须能访问模型 API；手机能访问服务商网站并不代表电脑也能调用 API。

模型 Key 保存于电脑当前用户的 `.sscode` 数据目录；Windows 文件访问保护取决于账户及文件 ACL，不应把该目录共享给其他用户。

可用下面的任务做首次验证：

> 在当前项目创建 hello.py，输出 Hello SSCode，运行验证并告诉我结果。

初次使用建议选择常规审批，查看 AI 请求执行的操作后再批准。“全接管”会自动执行更多操作，仅在了解其权限含义时启用。终端使用 PowerShell，但当前 **AI 的 run_command 工具通过 cmd.exe 执行**，两者命令语法可能不同。

### 6.4 可选：完整 IDE

Windows 原生不能直接运行 code-server。需要在 WSL 内自行安装并启动 code-server，监听 `127.0.0.1:8080`，并确保 Windows 侧能访问该地址；WSL 的回环转发行为取决于其网络配置。

准备好后，在 App 点击“完整 IDE”。密码在 WSL 内 code-server 配置中查看，SSCode 不会自动读取它。未配置 WSL IDE 不影响文件、AI、Git 和普通终端功能。

本版本 Windows 核心链路经过模拟器验收；真实模型、实体手机全部场景及实际 WSL IDE 的覆盖范围见 [验收记录](docs/验证记录/Windows端到端验收-2026-09-20.md)。

## 7. 常见问题：按报错阶段排查

| 报错或现象 | 含义 | 优先检查 |
|---|---|---|
| 连接 `10.0.2.2` 超时 | 使用了模拟器专用地址 | 换成电脑的 Tailscale IP 或局域网 IP |
| `No route to host` / `EHOSTUNREACH` | 网络不可达，尚未验证密码 | 校园网设备隔离、IP 是否改变；尝试 Tailscale |
| `failed to connect ... after 15000ms` | TCP 22 未建立连接 | Tailscale 状态、访问策略、电脑防火墙、sshd 是否监听 |
| `Connection refused` | 目标拒绝连接 | SSH 服务是否启动，端口是否正确 |
| 认证失败 | 已到认证阶段 | 用户名、账户密码与 PIN 的区别、私钥是否匹配授权公钥 |
| 主机指纹变化 | 服务器身份与记录不一致 | 核对主机和当前指纹后再决定是否重新信任 |
| SSH 成功，但服务授权失败 | 无法访问配套服务或获取令牌 | 7823 健康检查、启动服务的 Windows 用户是否与 SSH 用户一致 |
| 重启后无法连接 | 某个后台服务没恢复 | 分别检查 Tailscale、sshd 和 sscode-server；配套服务自启是否需要先登录 |
| `Access is denied` / 拒绝访问 | 当前 PowerShell 权限不足 | 服务管理或防火墙操作使用管理员窗口 |
| `EADDRINUSE ... 7823` | 配套服务重复启动或端口被占用 | 先检查健康接口及占用进程，不要反复启动 |
| AI 测试失败 | 模型调用失败 | 电脑到 API 的网络、Base URL、Key、模型权限及工具调用支持 |
| App 提示会话过期 / 接口返回 401、403、429 | 设备会话失效、角色不足或触发限流 | 见 [故障排查](docs/故障排查.md)：401 自动刷新后重绑定、403 角色与迁移窗口、429 退避 |

### 电脑端诊断命令

```powershell
# 1. SSH 是否运行并监听
Get-Service sshd | Select-Object Name,Status,StartType
Get-NetTCPConnection -State Listen -LocalPort 22

# 2. 配套服务是否正常
Invoke-RestMethod http://127.0.0.1:7823/v1/health

# 3. Tailscale 两端是否在线
& "$env:ProgramFiles\Tailscale\tailscale.exe" status

# 4. 替换为手机的 Tailscale IP，验证虚拟网络连通
& "$env:ProgramFiles\Tailscale\tailscale.exe" ping 100.100.100.100
```

Tailscale ping 成功只证明虚拟网络可达，仍需检查 SSH 22 端口和防火墙。若同一 Wi-Fi 不能直连，不要仅因为两端地址前几段相似就认定它们能互访。

## 8. 日常使用与升级

每次使用前确认：电脑开机且未休眠 → 网络/Tailscale 已连接 → SSH 运行 → 配套服务健康 → 手机连接项目。

升级时：

1. 等待当前 AI 任务结束，保存文件；配套服务重启会影响任务和 Windows 终端会话，各设备的会话 access token 也会失效（App 会自动换新，无需重新绑定）。
2. 升级服务端前先备份 `%USERPROFILE%\.sscode\sscode.db`；失败回滚步骤见 [部署指南](docs/部署指南.md) 第 4 节。
3. 手机安装相同包名、相同签名且 versionCode 更高的 APK，可覆盖安装。
4. 更新电脑上的 `server` 文件并重新启动配套服务，再检查 `/v1/health`。**只更新手机 APK 不会自动替换已运行的 Windows 服务。**
5. 保留 `%USERPROFILE%\.sscode` 数据目录；不要将模型密钥、SSH 私钥或访问令牌发到公开渠道。

相关文档：[0.2.4 版本说明](docs/0.2.4-release.md)、[Windows 验收记录](docs/验证记录/Windows端到端验收-2026-09-20.md)、[部署指南](docs/部署指南.md)、[故障排查](docs/故障排查.md)、[服务端说明](server/README.md)、[Android 构建说明](android/README.md)。
