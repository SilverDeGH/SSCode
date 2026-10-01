# API Key 绑定、会话共享与远程 Codex 任务计划

**版本：V0.1**  
**编制日期：2026-09-30**  
**适用项目：SSCode**  
**目标：手机通过模型 API Key 首次绑定 SSCode，之后使用本地登录会话查看和操作由 SSCode 自己运行的 Codex/模型任务。**

## 1. 目标与边界

### 1.1 目标

- SSCode Server 自己创建、排队和执行 AI 编程任务。
- 手机首次输入 API Key，服务器验证模型连接后保存 Key 并签发设备会话。
- 后续请求只携带会话 Token；API Key 不返回手机、不进入 URL、日志、事件或错误信息。
- 多台手机可以访问同一台电脑上的项目、会话和任务。
- 通过项目级权限控制查看、提交、停止、审批和管理操作。
- 实时同步任务状态、模型消息、工具调用、审批请求和文件变更。
- 保留现有 SSH/Tailscale 连接方式，新增会话认证不破坏旧客户端。

### 1.2 明确不做

- 不桥接 Codex Desktop，不读取或控制 Codex Desktop 私有会话。
- 不把 API Key 当作长期登录 Token。
- 不直接把 HTTP 服务暴露到公网。
- 不在第一阶段实现跨主机任务迁移。
- 不把隐藏推理过程或不必要的完整凭据复制到手机。

## 2. 现状与复用点

现有服务端已经提供以下基础能力：

| 能力 | 现有位置 | 复用方式 |
|---|---|---|
| OpenAI 兼容接口 | `server/src/ai/openaiCompat.ts` | 继续支持 Chat Completions 和 Responses |
| API Key 存储 | `server/src/ai/secrets.ts` | 继续只在电脑端保存，后续加强 Windows 保护 |
| 任务执行与队列 | `server/src/engine/engine.ts` | 作为唯一任务执行器 |
| 项目、会话、任务数据库 | `server/src/db/schema.ts`、`repo.ts` | 增加设备、会话和成员表 |
| 审批机制 | `engine.ts`、`permission.ts` | 叠加项目角色权限 |
| 事件游标 | `events` 表和 `/v1/events` | 扩展为会话过滤和实时订阅 |
| Android API 客户端 | `android/.../SscodeApi.kt` | 增加绑定、刷新和会话管理 |
| Android 凭据保存 | `CredentialStore.kt` | 保存 refresh token 和设备标识 |

## 3. 总体架构

```text
手机 App
  │  首次：API Key + 服务地址
  │  后续：access token / refresh token
  ▼
SSCode Server
  ├─ AuthService：绑定、会话、设备撤销
  ├─ ProjectPolicy：项目成员和角色
  ├─ TaskEngine：任务队列与执行
  ├─ SecretsStore：模型 API Key，仅服务器可读
  ├─ EventStream：SSE/WebSocket 实时事件
  └─ SQLite：项目、会话、任务、审批和审计记录
             │
             ▼
       OpenAI/Codex 兼容模型服务
```

API Key 的生命周期：

1. 手机通过加密传输提交 API Key 和模型配置。
2. 服务器调用模型的最小测试请求验证 Key 和工具调用能力。
3. 验证成功后，Key 写入受保护存储，返回脱敏后的模型配置。
4. 服务器签发设备会话；手机只保存会话凭据。
5. API Key 只能通过服务器端任务执行使用，不能通过普通 API 读回。
6. 更换或删除模型配置时同步删除旧凭据引用。

## 4. 认证与会话设计

### 4.1 首次绑定接口

新增接口：

```text
POST /v1/auth/link
```

请求示例：

```json
{
  "deviceName": "Pixel 8",
  "name": "OpenAI",
  "baseUrl": "https://api.openai.com/v1",
  "model": "gpt-5",
  "apiKey": "<仅通过 HTTPS/SSH 传输>"
}
```

服务端行为：

- 校验字段、URL、模型名称和 Key 长度。
- 使用 `createAdapter(...).test()` 验证连接和工具调用能力。
- 成功后创建模型配置和设备记录。
- 返回 `accessToken`、`refreshToken`、过期时间、设备 ID 和默认项目摘要。
- 响应绝不包含 API Key 或完整授权请求原文。

API Key 登录必须被视为“首次绑定凭证”，不能单独作为每次请求的身份认证。持有同一 Key 的人可能拥有相同的模型调用权限，因此绑定接口还应支持本地管理员确认或一次性配对码作为增强保护。

### 4.2 会话接口

```text
POST /v1/auth/refresh
POST /v1/auth/revoke
GET  /v1/auth/me
GET  /v1/auth/devices
DELETE /v1/auth/devices/:id
```

建议策略：

- access token：短期有效，例如 15 分钟。
- refresh token：随机高熵值，只保存哈希，支持轮换和撤销。
- 每个设备独立会话，不能复用服务器全局静态 Token。
- refresh token 轮换后旧 Token 立即失效。
- 删除设备时立即撤销其全部会话。
- 保留旧 `authToken` 兼容开关，迁移完成后再废弃。

### 4.3 数据库表

通过版本化迁移新增：

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, device_id)
);
```

角色只允许：

| 角色 | 查看 | 提交任务 | 停止任务 | 审批 | 项目/Key/成员管理 |
|---|---:|---:|---:|---:|---:|
| `owner` | 是 | 是 | 是 | 是 | 是 |
| `operator` | 是 | 是 | 是 | 是 | 否 |
| `reviewer` | 是 | 否 | 否 | 可配置 | 否 |
| `viewer` | 是 | 否 | 否 | 否 | 否 |

## 5. API 改造清单

### 5.1 认证中间件

- 把 `server.ts` 中的静态 `authToken` 校验抽象为 `AuthContext`。
- 同时支持迁移期的旧 Bearer Token 和新 access token。
- 路由执行前解析 `deviceId`、会话 ID 和权限范围。
- 所有非 health、link、refresh 路由必须认证。
- WebSocket/事件流必须同样执行会话认证，禁止只依赖 URL 中的明文 Token。

### 5.2 项目和任务权限

对现有路由增加权限检查：

```text
GET    /v1/projects
GET    /v1/projects/:id/sessions
GET    /v1/tasks
GET    /v1/tasks/:id
POST   /v1/tasks
POST   /v1/tasks/:id/messages
POST   /v1/tasks/:id/stop
POST   /v1/tasks/:id/answer
POST   /v1/tasks/:id/approval-mode
POST   /v1/approvals/:id/decision
GET    /v1/events
```

要求：

- 通过任务所属项目反查成员权限。
- 不允许用客户端提交的 `projectId` 绕过权限。
- 任务创建时校验 `sessionId` 确实属于目标项目。
- 事件流只返回授权项目的事件。
- 所有写操作增加审计事件，记录设备和角色，不记录 API Key。

### 5.3 实时同步

第一阶段优先复用事件游标轮询，减少协议风险；第二阶段增加 SSE：

```text
GET /v1/events/stream?projectId=<id>&after=<cursor>
```

事件至少包括：

```text
task.created
task.state
task.message
tool.started
tool.completed
approval.requested
approval.decided
task.changed
```

断线后客户端使用最后游标补发，不能只依赖内存事件。

## 6. Android 端改造

### 6.1 新增页面

- “连接 SSCode”页面：服务器地址、传输方式、证书/SSH 状态。
- “绑定模型”页面：服务商预设、Base URL、模型、API Key、连接测试。
- “设备会话”页面：设备名称、最后在线时间、退出当前设备、撤销其他设备。
- “项目成员”页面：拥有者邀请/撤销设备并设置角色。

### 6.2 凭据存储

- access token 仅驻留内存或短期缓存。
- refresh token 使用 Android Keystore 保护的 `CredentialStore` 保存。
- API Key 不保存到手机；绑定请求完成后立即清除输入框和临时变量。
- 日志、崩溃报告和错误弹窗不得输出请求体。
- 收到 401 时只尝试一次 refresh，失败后回到绑定页。

### 6.3 任务协作 UI

- 项目和任务卡片显示当前用户角色。
- 无权限操作隐藏或禁用，而不是提交后再失败。
- 审批卡片显示风险摘要、操作描述和发起设备。
- 多设备更新时使用事件游标刷新，避免覆盖本地正在编辑的输入。
- 任务详情显示连接状态、最后事件时间和重连状态。

## 7. 安全要求

### 必须满足

- 禁止 API Key 出现在 URL、日志、数据库普通表、事件 payload 和错误文本。
- 绑定和刷新接口必须限流，连续失败后退避。
- 生产远程访问只允许 SSH 隧道、Tailscale/VPN 或 HTTPS。
- API Key 绑定成功前不得创建可执行任务。
- 所有任务控制操作必须经过项目权限检查。
- refresh token 只存哈希，不存明文。
- 设备撤销后现有 access token 在权限检查时立即失效，不能等自然过期。
- Windows 凭据保护优先使用 DPAPI；文件权限仅作为后备措施。
- 对命令执行、文件删除、项目删除和 Key 变更保留审计记录。

### 明确禁止

- 将 API Key 放在二维码、深链接或剪贴板内容中。
- 允许手机直接读取 `/v1/models/:id/key`。
- 允许 `viewer` 调用停止、审批或终端接口。
- 通过公网端口直接暴露任务和文件 API。

## 8. 分阶段执行计划

### P0：协议和安全基线

- [x] 固化认证流程、Token 过期策略和角色矩阵。
- [x] 确认 API Key 支持范围：OpenAI Responses、Chat Completions 和兼容服务商。
- [x] 定义数据库迁移版本和回滚策略。
- [x] 定义旧客户端兼容窗口。
- [x] 补充隐私和威胁模型文档。

### P1：服务端会话认证

- [x] 实现 `devices`、`auth_sessions`、`project_members` 迁移。
- [x] 实现 refresh token 哈希、轮换和撤销。
- [x] 实现 `POST /v1/auth/link`，验证 Key 后创建模型配置和设备会话。
- [x] 把静态 Bearer 校验抽象为认证上下文。
- [x] 增加会话、设备和绑定失败的限流。
- [x] 为认证模块补齐单元测试和 API 测试。

### P2：项目权限和审计

- [x] 实现 owner/operator/reviewer/viewer 权限判断。
- [x] 给项目、会话、任务、审批、事件接口加权限检查（文件/git/终端/IDE 接口在迁移窗口内仅开放本地管理员 Token，后续按项目角色细化）。
- [x] 增加设备管理和成员管理 API。
- [x] 增加脱敏审计事件。
- [x] 验证多设备并发提交、停止和审批的幂等性。

### P3：实时任务共享

- [x] 先完成带游标的事件轮询客户端。
- [x] 增加 SSE 事件流和断线恢复。
- [x] Android 端实现任务状态、消息、审批实时刷新。
- [x] 验证两个以上设备同时查看和操作同一任务。（旧管理员 + 模拟器设备会话并发查看/写同一任务，见 docs/验证记录/模拟器会话认证验证-2026-09-30.md）

### P4：Android 首次绑定流程

- [x] 增加 API Key 绑定页面和服务商预设选择。
- [x] 使用 Keystore 保存 refresh token。
- [x] 增加自动刷新、退出、撤销和重新绑定流程。
- [x] 清理 API Key 输入内容、日志和错误展示。
- [x] 完成无权限状态和会话过期状态 UI。

### P5：联调和发布

- [ ] OpenAI Responses 真实 Key 联调。
- [x] 至少一种独立 OpenAI 兼容服务商联调。（gpt.ge + gpt-5.5，见 docs/验证记录/独立兼容服务商联调-gptge-2026-09-30.md）
- [ ] Windows 10/11、Android 8 至当前版本验证。
- [ ] Tailscale、SSH 隧道和局域网三种连接方式验证。
- [ ] 完成安全测试、压力测试、升级迁移测试。
- [x] 更新 README、部署指南、隐私说明和故障排查文档。

## 9. 测试矩阵

### 服务端

- API Key 正确、错误、过期、权限不足和服务商超时。
- Key 不出现在响应、日志、事件、数据库普通查询和异常中。
- access token 过期、refresh token 轮换、重复使用旧 refresh token。
- 设备撤销后所有接口立即返回 401/403。
- 四种角色对所有项目和任务 API 的允许/拒绝矩阵。
- 事件按项目过滤，断线后按游标不重不漏。
- 两台设备同时提交相同 `X-Client-Request-Id` 只能产生一个任务。
- 任务运行期间另一设备停止、审批和追加提示词。
- 数据库从旧版本迁移和失败回滚。

### Android

- 首次绑定成功和失败提示。
- Token 刷新和网络断开恢复。
- API Key 不进入本地持久化和日志。
- 任务实时状态、审批和消息不会覆盖用户正在编辑的输入。
- 撤销设备后页面正确退出并清理本地会话。
- 横竖屏、进程重启和低网络质量场景。

### 安全验证

- 静态扫描 API Key、refresh token 和 Authorization 日志。
- 尝试跨项目读取、提交、停止和审批。
- 尝试伪造 `projectId`、`sessionId` 和事件游标。
- 尝试重放绑定请求和 refresh token。
- 明确验证服务不监听公网地址，或仅经受控隧道访问。

## 10. 完成定义

只有同时满足以下条件，才认为该功能完成：

1. 手机可以使用 API Key 完成一次绑定，并成功获得设备会话。
2. 后续请求不需要再次提交 API Key。
3. 服务器可以独立执行任务并保存完整可见进度。
4. 两台授权设备可以同时查看同一项目和任务。
5. 角色权限能阻止未授权的读取、提交、停止和审批。
6. 任务事件支持断线恢复，且不重复执行任务。
7. API Key、refresh token 和敏感路径不会泄露到客户端或日志。
8. 旧 SSH/Tailscale 工作流仍然可用。
9. 服务端测试、Android 构建、真实模型联调和 Windows 真机验收全部通过。

## 11. 主要风险与取舍

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| API Key 被当作登录密码传播 | 高 | 只用于首次绑定；短期 access token；refresh 撤销；推荐配对码 |
| 手机网络不安全 | 高 | SSH/Tailscale/VPN/HTTPS；禁止公网裸 HTTP |
| 多设备同时控制任务 | 中 | 项目角色、幂等键、任务状态机和审计事件 |
| Windows 文件凭据保护不足 | 高 | DPAPI 优先，Key 文件仅作后备，限制服务账户权限 |
| 服务端升级破坏会话 | 中 | 数据库版本迁移、Token 兼容窗口、回滚脚本 |
| 模型服务商协议差异 | 中 | 沿用适配器抽象；绑定时验证工具调用，不只验证 HTTP 200 |
| 事件量持续增长 | 中 | 游标索引、保留策略、按项目过滤和定期清理 |

## 12. 第一批实现顺序

建议实际编码顺序为：

1. 先实现服务端会话表、Token 轮换和 `/v1/auth/link`。
2. 再把现有任务/审批 API 接入项目权限检查。
3. 然后实现事件流和断线恢复。
4. 最后改 Android 首次绑定、会话保存和任务协作界面。

这样可以先在不改变任务引擎的情况下验证安全边界，再扩展手机端体验。
