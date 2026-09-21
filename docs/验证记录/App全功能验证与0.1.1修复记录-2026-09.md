# App 全功能真机验证与 0.1.1 修复记录

**日期：2026-09-19** · **客户端版本：SSCode v0.1.1（versionCode 2）** · **环境：Android 模拟器 sscode35（API 35）+ 真实服务器 K0703（218.84.111.20:3751，Ed25519 私钥认证）+ 真实模型（百炼 Token Plan kimi-k2.7-code）**

## 1. 起因：用户报告两处闪退

- 添加服务器时点击"私钥"闪退；
- 点击"编辑"（编辑服务器信息）闪退。

logcat 实捕堆栈：

```
java.lang.IllegalStateException: No ActivityResultRegistryOwner was provided via LocalActivityResultRegistryOwner
    at androidx.activity.compose.ActivityResultRegistryKt.rememberLauncherForActivityResult(...)
    at dev.sscode.app.ui.ServerEditScreenKt.ServerEditScreen(ServerEditScreen.kt:71)
```

**根因**：MainActivity 为实现应用内语言覆盖，用 `createConfigurationContext` 替换了 Compose 的 `LocalContext`。该 context 不是 Activity，`rememberLauncherForActivityResult` 的 `LocalContext as? ActivityResultRegistryOwner` 回退得到 null，含 launcher 的编辑页一进入组合即崩。添加页与编辑页是同一界面，故两处同时闪退。

## 2. 本轮修复（全部经真机回归）

| # | 问题 | 修复 | 文件 |
|---|---|---|---|
| 1 | 添加/编辑服务器页闪退（上述根因） | 语言覆盖改为 `attachBaseContext` 落在 Activity 自身 base context，语言切换时 `recreate()`；移除 LocalContext 替换 hack | MainActivity.kt |
| 2 | 文件页/编辑器的工具栏被工作区顶栏遮挡（无法保存、无查找、无文件名） | WorkspaceScreen 文件分支补上外层 Scaffold padding + consumeWindowInsets | WorkspaceScreen.kt |
| 3 | 所有 AlertDialog 文案回落到系统语言（英文），与主界面不一致 | 同 #1（Dialog 另起 Window，context 取自 Activity） | MainActivity.kt |
| 4 | SSH 隧道空闲数分钟被断开，工作区"重试"无效 | sshj 连接启用 30s 心跳保活（HEARTBEAT） | SshManager.kt |
| 5 | 终端完全空白：快照只含顶部几行时，"跟随末尾"滚动把内容顶出可视区 | TerminalModel.snapshot() 去掉网格尾部空行 | TerminalModel.kt |
| 6 | 终端初始画面阶梯状错位：capture-pane 快照为纯 `\n` 拼接 | TerminalModel 将 LF 按 CR+LF 处理 | TerminalModel.kt |
| 7 | 环境检测 code-server 误报"未安装"（用户目录安装不在 PATH） | 探测补 `~/.local/opt/code-server-current/bin/code-server`，版本号只取首字段 | EnvDetector.kt |

## 3. 全功能真机验证结果（0.1.1，全部通过）

| 模块 | 验证点 | 结果 |
|---|---|---|
| 服务器列表 | 添加（密码/私钥两种认证表单）、保存、编辑、删除（确认对话框+凭据清理） | 通过 |
| 私钥导入 | 私钥 FilterChip 切换、SAF 文件选择器打开、id_ed25519 导入 PEM 回填 | 通过 |
| 连接与环境检测 | Ed25519 私钥连接、指纹记录、12 项环境行（含 code-server 4.106.3） | 通过 |
| 项目列表 | demo / AAD 两项目卡片、任务计数 | 通过 |
| AI 任务 | 真实模型任务提交 → 执行中 → 已完成，总结与文件变更正确（hello.py 实建） | 通过 |
| 文件 | 目录进入/面包屑、新建文件、长按菜单、删除确认、刷新 | 通过 |
| 编辑器 | 打开、编辑脏标记、保存（乐观锁）、保存后落盘（服务器侧大小回读一致） | 通过 |
| 终端 | WS 连接、初始快照渲染、命令执行回显、快捷键栏、字号 A-/A+ | 通过 |
| Git | 非仓库提示；AAD 仓库：分支/ahead/behind、M/D 徽章、diff 着色弹层、暂存按钮 | 通过 |
| IDE | code-server WebView 经第二条隧道加载、密码行（显示/复制）、登录后完整 VS Code | 通过 |
| 智能体配置 | 配置列表、按项目记忆选中、模型目录浏览 | 通过 |
| 外观与语言 | 中/英切换（recreate 后含对话框全量生效）、浅色/暗夜即时切换 | 通过 |
| 保活 | 工作区闲置 10 分钟后隧道存活，REST 正常 | 通过 |
| 稳定性 | 全程 logcat 无 FATAL | 通过 |

**未覆盖**（沿用 P1 记录口径）：密码认证、加密私钥口令、RSA 私钥、指纹变化阻断、编辑器 409 冲突对话框、审批卡片、安装 code-server 长流程。

## 4. 产物

- `dist/SSCode-0.1.1.apk`（debug 签名，沿用 0.1.0 分发方式）
- `dist/SSCode-0.1.1-wechat.zip`（微信传输用，内含上述 APK）

## 5. 增补：0.1.2 顶栏合并与全页面下拉刷新（2026-09-19 晚）

按用户反馈调整并真机回归：

| 改动 | 文件 | 验证 |
|---|---|---|
| 文件页去掉自带"← 项目名"顶栏，新建/刷新按钮提升到工作区顶栏与 Git/IDE 并列（仅文件列表模式显示，编辑器内自动隐藏） | FilesScreen.kt、WorkspaceScreen.kt | 通过 |
| 下拉刷新覆盖：服务器详情（重连+重新检测）、项目列表、AI 任务列表、文件、编辑器、Git、智能体配置 | 各 Screen.kt | 通过（logcat 零 FATAL） |
| 编辑器有未保存修改时下拉被拦截并提示，指示器用脉冲状态正常回弹（修复拦截分支指示器卡住问题） | EditorScreen.kt | 通过 |
| 加载/错误/空态等占位内容补 verticalScroll，保证非列表态下拉手势同样生效 | FilesScreen/GitScreen/ProjectListScreen/EditorScreen | 通过 |

未加下拉刷新的页面及原因：服务器列表（Room 本地数据实时流，无需刷新）、终端（WebSocket 实时会话，自带断线重连）、外观设置（纯本地）。

产物：`dist/SSCode-0.1.2.apk`、`dist/SSCode-0.1.2-wechat.zip`（versionCode 3）。

## 6. 增补：AI 对话界面 Codex 化（0.1.3，2026-09-20）

AI 页由任务卡片列表重构为 Codex 风格对话线程，服务端零改动（会话=session、一轮问答=task、执行中插话=tasks/:id/messages、附件=文件路径引用前缀）。

| 功能 | 实现 | 真机验证 |
|---|---|---|
| 对话线程 | 用户右气泡（含附件 chips）+ 助手左回合（模型名+状态+工具调用实时列表+完成后 summary）+ followTail 自动滚底 | 通过 |
| 新建对话 | ＋号进入草稿态，首条消息时 createSession（标题取输入前 20 字） | 通过（"run both attached fi"） |
| 对话切换 | SessionBar 下拉列出全部会话（标题+时间），线程按 sessionId 过滤 | 通过 |
| 附加文件 | AttachFileSheet 底部弹层浏览项目文件（面包屑/敏感文件灰显），chips 回填；发送时拼【附加文件】前缀 | 通过（模型真实运行了 calc.py/hello.py 并汇报输出） |
| 执行中追加 | 有活跃任务时发送走 appendTaskMessage | 通过（b11.txt 由追加产生并进入工具调用列表） |
| 回合详情 | "查看工作过程"/"N 个工具 · M 个文件改动"，展开时 lazy getTask + /changes | 通过（2 个工具 · 0 个文件改动） |
| 审批卡片 | 内嵌活跃回合（命令/原因/影响/批准/拒绝），批准后任务继续 | 通过（连续两道审批后任务完成） |

测试中发现并已修：附件弹层"完成"按钮原在列表下方需滚动可见且拖动关 sheet 易丢选择，已移到标题行右侧。

发现的既有服务端问题（未修，与本改动无关）：一运行中任务被停止后卡在 stopping 态阻塞队列（引擎 abort 未覆盖挂起的 LLM 调用），经 systemctl --user restart sscode-server 按既有设计转 interrupted 解除；另有 9-18 旧版本写入的会话标题乱码（当前服务端 UTF-8 链路实测正常）。

产物：`dist/SSCode-0.1.3.apk`、`dist/SSCode-0.1.3-wechat.zip`（versionCode 4），安装冒烟通过、logcat 零 FATAL。
