# sscode-server（配套服务 · 初版）

SScode Android 远程 AI 编程 App 的服务器端配套服务。运行在用户自有 Linux 服务器上，**只监听 127.0.0.1**，通过手机 App 建立的 SSH 隧道访问（对应需求 3.2：不开放公网端口）。

当前状态：P2 工程基础/协议/持久化 + P4 服务端 AI 执行闭环已完成并经本地自动化验证（58 项测试）；真实 Linux 服务器、真机与真实模型 Key 的验证待测试环境落实后执行（见 `docs/任务清单.md`）。

## 运行要求

- Node.js ≥ 22.18（使用 `node:sqlite` 与原生 TypeScript 运行，无第三方运行时依赖）
- 开发依赖（typecheck 用）：`npm install`

## 启动

```bash
cd server
npm install            # 仅开发依赖（typescript / @types/node）
npm start              # 默认数据目录 ~/.sscode，端口 7823
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SSCODE_DATA_DIR` | `~/.sscode` | 数据目录（SQLite、快照备份、secrets.json） |
| `SSCODE_PORT` | `7823` | 监听端口（仅 127.0.0.1） |

首次启动自动生成 API Token 打印到 stdout，并持久化于数据库 `kv_meta.auth_token`。

## 测试与检查

```bash
npm test          # node --test，58 项（单元 + API + 端到端 Mock 模型闭环）
npm run typecheck # tsc --noEmit，strict
```

## 架构

```
src/
  types.ts        共享契约：数据模型、任务状态机、权限判定、引擎门面、API 错误
  db/             node:sqlite 持久化：版本化迁移、全部实体的 Repo（状态转换校验、
                  审批幂等、事件游标、idempotency 去重）
  perm/           权限统一入口：工具执行前判定 auto / 单次审批 / 拒绝（P4-05）
  snapshot/       任务级文件快照与撤销：sha256 冲突检测，不覆盖任务前/后续改动
  ai/             模型适配：OpenAI 兼容客户端（工具调用）、MockAdapter、
                  SecretsStore（API Key 独立受限存储，不入库/日志/事件）
  engine/         任务引擎：项目内串行/项目间并发、执行循环、审批挂起、
                  停止（abort 模型请求与子进程）、追加要求、启动恢复（interrupted）
  api/            HTTP API：Bearer 鉴权、X-Client-Request-Id 去重、事件游标补发
  app.ts / index.ts  组合根与入口
```

关键可靠性语义（对应需求验收 8/9/11/17）：

- 任务提交按 `(projectId, clientRequestId)` 去重；同一 `X-Client-Request-Id` 重复 POST 返回缓存响应，不产生第二个任务。
- 审批决策幂等：重复批准/拒绝返回原决定，不产生重复副作用。
- 服务重启：非终态任务置为 `interrupted` 等待用户确认，结果未知的命令不自动重放；`queued` 任务保留并继续调度。
- 撤销只覆盖被可靠记录的文件修改；恢复前重新计算文件 hash，与任务结束时记录不一致即标记冲突、不覆盖。
- 事件写入 SQLite（自增 id 即游标），手机断线重连后 `GET /v1/events?after=<cursor>` 补发增量。

## API 摘要（全部 `/v1` 前缀，除 `/v1/health` 外需 `Authorization: Bearer <token>`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 版本握手（免鉴权） |
| POST/GET | `/v1/projects` | 新建（规范化路径查重 409）/ 列表（附任务计数） |
| GET/DELETE | `/v1/projects/:id` | 详情 / 删除（级联清理任务记录，不动项目代码） |
| POST/GET | `/v1/projects/:id/sessions` | 会话创建 / 列表 |
| POST | `/v1/tasks` | 提交任务，**必填 header `X-Client-Request-Id`**（去重） |
| GET | `/v1/tasks?projectId=` / `/v1/tasks/:id` | 列表 / 详情（含工具调用与待审批） |
| POST | `/v1/tasks/:id/messages` `/answer` `/stop` `/cancel` `/resume` `/undo` | 追加要求 / 回答澄清 / 停止 / 取消排队 / 中断后重新排队 / 撤销 |
| GET | `/v1/tasks/:id/changes` | 变更文件列表（修改审查页数据源） |
| POST | `/v1/approvals/:id/decision` | `{decision: approve\|reject, note?}`，幂等 |
| GET | `/v1/events?after=&projectId=&limit=` | 事件游标补发 |
| CRUD | `/v1/models` | 模型配置；`POST /v1/models/:id/default`、`/test`（连接与工具调用能力测试） |
| GET | `/v1/models/presets` | 服务商预设（Kimi 国内/国际、百炼按量/Coding Plan/Token Plan、自定义），含 Key 获取入口与 Base URL 配对指引 |
| POST | `/v1/models/:id/key` | 写入/更新模型 Key（`{apiKey}`，入受保护存储，响应不含明文）；创建配置时也可直接带 `apiKey` 字段 |
| GET | `/v1/files/list` `/v1/files/content` | 目录浏览 / 文件读取（含 sha256 版本、截断标记；敏感文件 403） |
| POST/DELETE | `/v1/files/write` `/create` `/rename` `/move` · `DELETE /v1/files` | 文件写（baseHash 乐观锁，409 冲突）/ 新建 / 重命名 / 移动 / 删除；全部限制在项目目录内 |
| GET/POST | `/v1/git/status` `/diff` `/stage` `/unstage` `/commit` `/pull` `/push` `/branch` `/checkout` | 基础 Git；认证失败返回 `git_auth_failed`，冲突 409 引导完整 IDE |
| WS | `/v1/terminal/ws?projectId=&token=` | 交互终端（tmux 持久会话：send-keys 输入 + pipe-pane 输出 + capture-pane 重连快照）；另有 `GET /v1/terminal/status` |
| GET/POST | `/v1/ide/status` `/install` `/start` `/stop` `/access` | code-server 生命周期：检测/安装（支持代理参数）/systemd 用户服务启动/访问信息（密码经鉴权接口下发） |

模型 Key 管理规则：`apiKey` 与 `apiKeyRef` 二选一；给 `apiKey` 时服务端生成 `key-` 前缀引用存入 `secrets.json`；删除配置会连带删除对应 Key。任何响应都不回显 Key 明文。

错误统一为 `{error:{code,message,details?}}`；code 取值见 `src/types.ts` 的 `ERR`。

## 已知限制（初版）

- 模型适配实测覆盖：Mock、百炼 Token Plan 端点（kimi-k2.7-code 真实工具调用通过）；第二种独立兼容接口与 Kimi 官方端点（api.moonshot.cn）待测试账号（验收 5）。
- 真实 Linux 环境已验证 Ubuntu 22.04 x86_64（systemd 用户服务）；ARM64、无 systemd 的降级路径、SSH 隧道与 Android 客户端未包含在本仓库部分。
- `run_command` 导致的文件变化目前依赖命令结果文本记录，未做全量前后比对；撤销范围以快照记录为准并在 UndoReport.caveats 中声明。

## Windows 宿主（本机直连场景）

服务端可在 Windows 上原生运行（Node ≥22.18，无第三方依赖）。手机经 SSH 连接本机后走「连接已有服务」直连，与 Linux 服务器体验一致，差异如实列出：

- **启动**：`powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1`（数据目录 `%USERPROFILE%\.sscode`，仍只监听 127.0.0.1:7823）；登录自启用 `scripts\start-windows-autostart.ps1` 注册计划任务。
- **认证 token**：启动后写入 `%USERPROFILE%\.sscode\auth-token`（Linux 同路径），App 经 SSH 读该文件获取；stdout 仍会打印。
- **终端**：Windows 无 tmux，使用 `persist` 后端（PowerShell/cmd 常驻 + 环形缓冲回放）：断线可接回（服务进程存活期间），但服务重启后会话丢失，且不支持 vim 等全屏交互程序。`/v1/health` 的 `terminalBackend` 字段上报当前后端。
- **完整 IDE**：code-server 不支持 Windows 原生安装。在 WSL 内安装并启动 code-server 监听 127.0.0.1:8080（WSL2 自动转发到宿主回环），App 即可探测到并经隧道访问；密码在 WSL 内查看。
- **AI 命令**：经 cmd.exe 执行（服务端已自动前置 `chcp 65001` 保证 UTF-8 输出；系统提示词会告知模型宿主为 Windows）。
