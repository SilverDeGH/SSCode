/**
 * SScode 配套服务 · 共享类型与契约定义
 * 所有模块（db / engine / ai / perm / snapshot / api）以此文件为唯一契约。
 * 对应文档：需求汇总.md、工作计划.md（P2 数据结构与状态机、P4 权限与恢复）。
 */

// ---------------------------------------------------------------- 基础枚举

/** 任务状态机（需求 6.4） */
export type TaskState =
  | 'queued'             // 排队中
  | 'running'            // 执行中
  | 'awaiting_input'     // 等待用户回答（AI 澄清）
  | 'awaiting_approval'  // 等待审批
  | 'stopping'           // 正在停止
  | 'completed'          // 已完成
  | 'failed'             // 已失败
  | 'blocked'            // 受阻（认证失败/额度不足/反复失败）
  | 'stopped'            // 已停止（用户主动）
  | 'interrupted';       // 因服务重启中断，等待用户确认

export const TERMINAL_STATES: readonly TaskState[] = [
  'completed', 'failed', 'blocked', 'stopped', 'interrupted',
];

/** 允许的状态转换表（P2-03 状态机） */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  queued:            ['running', 'stopped'],            // stopped = 取消排队
  running:           ['awaiting_input', 'awaiting_approval', 'stopping', 'completed', 'failed', 'blocked', 'interrupted'],
  awaiting_input:    ['running', 'stopping', 'interrupted'],
  awaiting_approval: ['running', 'stopping', 'interrupted'],
  stopping:          ['stopped', 'interrupted'],
  completed:         [],
  failed:            [],
  blocked:           ['queued'],                        // 用户修正配置后可重新排队
  stopped:           [],
  interrupted:       ['queued'],                        // 用户确认后重新排队；未知结果命令不重放
};

export type ToolName =
  | 'read_file'
  | 'write_file'      // 新建或修改文件（执行前自动快照）
  | 'delete_file'
  | 'search'          // 项目内搜索
  | 'run_command'
  | 'finish';         // AI 汇报总结并结束任务

export type ToolCallState = 'pending' | 'awaiting_approval' | 'approved' | 'rejected' | 'running' | 'done' | 'failed' | 'skipped';

/** 权限判定结果（P4-05：工具执行前统一入口） */
export type PermissionDecision =
  | { kind: 'auto' }                                  // 自动执行
  | { kind: 'requires_approval'; reason: string; riskSummary: string }  // 单次确认
  | { kind: 'deny'; reason: string };                 // 禁止（如敏感文件）

export type FileChangeKind = 'created' | 'modified' | 'deleted';

// ---------------------------------------------------------------- 数据模型（P2-02）

export interface Project {
  id: string;              // uuid
  name: string;            // 展示名
  path: string;            // 规范化后的绝对路径（队列识别依据）
  isGit: boolean;
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
}

export type ApprovalMode = 'manual' | 'auto' | 'full';

export interface Task {
  approvalMode?: ApprovalMode;
  id: string;
  projectId: string;
  sessionId: string;
  seq: number;                   // 项目内队列顺序
  state: TaskState;
  input: string;                 // 用户需求原文
  summary: string | null;        // 结束总结：做了什么/改了哪些文件/验证结果/遗留
  modelConfigId: string | null;  // 任务开始时确定的模型
  clientRequestId: string;       // 客户端请求标识（去重）
  createdByDeviceId: string | null; // 提交任务的设备；旧静态 Token 或迁移前数据为 null
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface ToolCall {
  id: string;
  taskId: string;
  seq: number;
  tool: ToolName;
  args: Record<string, unknown>; // 已脱敏存储
  state: ToolCallState;
  result: string | null;         // 摘要或错误信息（截断存储）
  approvalId: string | null;
  createdAt: number;
  endedAt: number | null;
}

export interface Approval {
  id: string;
  taskId: string;
  toolCallId: string;
  operation: string;        // 人类可读操作描述
  params: Record<string, unknown>;
  reason: string;
  riskSummary: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  decidedAt: number | null;
  note: string | null;      // 拒绝时补充要求
  requesterDeviceId: string | null; // 发起任务的设备；旧静态 Token 或迁移前数据为 null
  createdAt: number;
}

/** 事件记录（断线重连补发依据，id 单调递增即游标） */
export interface EventRecord {
  id: number;               // 自增，事件游标
  projectId: string | null;
  taskId: string | null;
  type: string;             // task.created / task.state / task.changed / tool.start / tool.end / approval.requested / approval.decided / task.message / task.appended / audit / log / codex.task.state（本机 Codex 任务列表变化，projectId=null，payload {available, taskCount}） / codex.task.updated（单个 Codex 任务变化，projectId 为 cwd 命中的 SSCode 项目，可空，payload {task}）
  payload: Record<string, unknown>;
  createdAt: number;
}

/** 任务级快照：一次任务一个快照记录 */
export interface Snapshot {
  id: string;
  taskId: string;
  projectId: string;
  createdAt: number;
  undoneAt: number | null;
}

/** 快照内的单文件记录（撤销与冲突检测依据） */
export interface SnapshotFile {
  id: string;
  snapshotId: string;
  path: string;             // 绝对路径
  changeKind: FileChangeKind;
  existedBefore: boolean;   // 任务前是否存在
  beforeHash: string | null;// 任务前内容 sha256（不存在为 null）
  afterHash: string | null; // 任务最后一次写入后的 sha256（被删除为 null）
  backupPath: string | null;// 原始内容备份文件（快照目录内相对路径）
}

export interface ModelConfig {
  id: string;
  name: string;             // 展示名，如 "Kimi"
  baseUrl: string;          // OpenAI 兼容地址
  model: string;            // 模型名
  apiKeyRef: string;        // 凭据引用（真实 Key 存受保护存储，不落库明文）
  isDefault: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------- 会话认证（P1，计划文档 4.3）

/** 项目角色（权限矩阵见计划文档 4.3；P2 起逐路由启用检查） */
export type ProjectRole = 'owner' | 'operator' | 'reviewer' | 'viewer';

export const PROJECT_ROLES: readonly ProjectRole[] = ['owner', 'operator', 'reviewer', 'viewer'];

/** 绑定的客户端设备（手机等） */
export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;   // 非 null 表示已撤销，立即失效
}

/** 设备登录会话；refresh token 只存 sha256 哈希，不存明文 */
export interface AuthSession {
  id: string;
  deviceId: string;
  refreshTokenHash: string;
  createdAt: number;
  expiresAt: number;          // refresh token 过期时间
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface ProjectMember {
  projectId: string;
  deviceId: string;
  role: ProjectRole;
  createdAt: number;
}

/**
 * 认证上下文：路由处理前解析出的调用者身份。
 * legacy = 旧静态 authToken（迁移兼容窗口内全通过）；session = 新设备会话。
 */
export type AuthContext =
  | { kind: 'legacy' }
  | { kind: 'session'; deviceId: string; sessionId: string };

// ---------------------------------------------------------------- 模型适配层契约

export interface ChatMessage {
  responseItems?: Record<string, unknown>[];
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: ToolName; args: Record<string, unknown> }[];
}

export interface ModelTurnResult {
  reasoningSummary?: string;
  responseItems?: Record<string, unknown>[];
  /** 助手文本（计划、解释、总结） */
  text: string;
  /** 本轮请求的工具调用（可为空表示纯文本轮） */
  toolCalls: { id: string; name: ToolName; args: Record<string, unknown> }[];
  /** token 用量，接口未返回时为 null（不伪造估算） */
  usage: { promptTokens: number; completionTokens: number } | null;
}

/** 模型适配器接口：mock 与 OpenAI 兼容客户端都实现它（P4-01） */
export interface ModelAdapter {
  chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelTurnResult>;
  /** 连接与工具调用能力测试 */
  test(): Promise<{ ok: boolean; detail: string }>;
}

export interface ToolSpec {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ---------------------------------------------------------------- 引擎对外门面（API 层依赖此接口）

export interface SubmitTaskInput {
  approvalMode?: ApprovalMode;
  projectId: string;
  sessionId: string;
  input: string;
  clientRequestId: string;
  modelConfigId?: string;
  /** 提交任务的设备 id（会话认证）；旧静态 Token 缺省为 null */
  requesterDeviceId?: string | null;
}

export interface EngineFacade {
  setApprovalMode(taskId: string, mode: ApprovalMode): Promise<Task>;
  submitTask(input: SubmitTaskInput): Promise<{ task: Task; deduplicated: boolean }>;
  appendMessage(taskId: string, text: string): Promise<Task>;       // 执行中追加要求
  answerTask(taskId: string, text: string): Promise<Task>;          // 回答 awaiting_input
  stopTask(taskId: string): Promise<Task>;
  cancelQueued(taskId: string): Promise<Task>;
  decideApproval(approvalId: string, decision: 'approve' | 'reject', note?: string): Promise<Approval>;
  undoTask(taskId: string): Promise<UndoReport>;
  resumeInterrupted(taskId: string): Promise<Task>;                 // 中断任务确认后重新排队
}

// ---------------------------------------------------------------- 撤销结果（P4-07、P4-08）

export interface UndoFileResult {
  path: string;
  changeKind: FileChangeKind;
  status: 'restored' | 'deleted' | 'conflict' | 'skipped';
  detail: string;
}

export interface UndoReport {
  taskId: string;
  snapshotId: string | null;
  results: UndoFileResult[];
  hasConflict: boolean;
  /** 命令副作用等无法可靠记录的范围说明；为空表示无此提示 */
  caveats: string[];
}

// ---------------------------------------------------------------- API 契约（P2-04）

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** 通用错误码 */
export const ERR = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  RATE_LIMITED: 'rate_limited',
  NOT_FOUND: 'not_found',
  INVALID_STATE: 'invalid_state',
  VALIDATION: 'validation_error',
  CONFLICT: 'conflict',
  INTERNAL: 'internal_error',
} as const;
