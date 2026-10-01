import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree } from '../util/prockill.ts';
import { removePath } from '../util/remove.ts';
import type {
  Approval,
  ChatMessage,
  EngineFacade,
  ModelAdapter,
  ModelTurnResult,
  Project,
  SubmitTaskInput,
  Task,
  TaskState,
  ToolCallState,
  ToolName,
  UndoReport,
} from '../types.ts';
import { ERR, TERMINAL_STATES } from '../types.ts';
import type { Repo } from '../db/repo.ts';
import { RepoError } from '../db/repo.ts';
import type { SnapshotStore } from '../snapshot/snapshot.ts';
import type { SecretsStore } from '../ai/secrets.ts';
import { TOOL_SPECS } from '../ai/toolspec.ts';
import { decidePermission } from '../perm/permission.ts';
import { isSensitiveDirSegment, normalizePath, resolveWithin } from '../util/paths.ts';
import { redactArgs, redactText } from '../util/redact.ts';

const COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_LIMIT = 8 * 1024;
const FILE_READ_LIMIT = 16 * 1024;
const RESULT_STORE_LIMIT = 8 * 1024;
const SEARCH_MATCH_LIMIT = 200;
const MAX_TURNS = 50;
const RESUME_NOTE = '重新排队：任务将从头由模型重新执行，结果未知的命令不会自动重放';

class StopRequested extends Error {
  constructor() {
    super('任务已停止');
    this.name = 'StopRequested';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface ApprovalAnswer {
  decision: 'approve' | 'reject';
  note: string | null;
}

interface TaskRuntime {
  messages: ChatMessage[];
  abort: AbortController;
  stopRequested: boolean;
  child: ChildProcess | null;
  projectRoot: string;
  totalUsage: { promptTokens: number; completionTokens: number };
}

export interface EngineDeps {
  repo: Repo;
  snapshots: SnapshotStore;
  secrets: SecretsStore;
  dataDir: string;
  resolveAdapter: (modelConfigId: string | null) => ModelAdapter;
}

function systemPrompt(projectRoot: string): string {
  const hostLine = process.platform === 'win32'
    ? '宿主环境：Windows，run_command 经 cmd.exe 执行——避免 bash 专属语法（$()、单引号、set -e 等），列目录用 dir、看文件用 type，路径正反斜杠均可。'
    : '宿主环境：Linux，run_command 经 shell 执行（bash 语法可用）。';
  return [
    '你是 SScode 远程编程助手，在用户的服务器项目目录中工作，通过调用工具完成任务。',
    '工作规则：',
    '- 修改文件前先用 read_file / search 了解现状；',
    '- 验证优先使用只读或构建测试类命令，高风险命令会请用户审批；',
    '- 完成后必须调用 finish 工具，summary 用中文说明：做了什么、改了哪些文件、验证结果、遗留问题。',
    `项目根目录：${projectRoot}`,
    hostLine,
  ].join('\n');
}

function truncate(s: string, limit: number, note: string): string {
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n...[${note}]`;
}

function describeOperation(tool: ToolName, args: Record<string, unknown>): string {
  const target =
    typeof args.path === 'string' ? args.path
    : typeof args.command === 'string' ? args.command
    : typeof args.pattern === 'string' ? args.pattern
    : '';
  return `${tool}${target !== '' ? ` ${target}` : ''}`.slice(0, 200);
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new RepoError(ERR.VALIDATION, `工具参数缺失或类型错误: ${key}`);
  }
  return v;
}

/** 项目内路径经 resolveWithin 解析；项目外绝对路径由审批门禁兜底（审批通过才允许） */
function resolveTarget(root: string, raw: string): string {
  try {
    return resolveWithin(root, raw);
  } catch (err) {
    if (path.isAbsolute(raw)) return normalizePath(raw);
    throw err;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runSearch(root: string, args: Record<string, unknown>): string {
  const pattern = strArg(args, 'pattern');
  const base = resolveTarget(root, typeof args.path === 'string' ? args.path : '.');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    re = new RegExp(escapeRegExp(pattern), 'i');
  }
  const matches: string[] = [];
  const visitFile = (file: string): void => {
    try {
      if (fs.statSync(file).size > 1024 * 1024) return;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\0')) return;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (re.test(line)) {
          matches.push(`${path.relative(root, file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (matches.length >= SEARCH_MATCH_LIMIT) return;
        }
      }
    } catch {
      // 读不了的文件跳过
    }
  };
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (matches.length >= SEARCH_MATCH_LIMIT) return;
      if (isSensitiveDirSegment(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) visitFile(full);
    }
  };
  try {
    if (fs.statSync(base).isDirectory()) walk(base);
    else visitFile(base);
  } catch {
    return `搜索目标不存在: ${typeof args.path === 'string' ? args.path : '.'}`;
  }
  if (matches.length === 0) return '无匹配结果';
  const suffix = matches.length >= SEARCH_MATCH_LIMIT ? `\n...[仅显示前 ${SEARCH_MATCH_LIMIT} 条]` : '';
  return matches.join('\n') + suffix;
}

export class TaskEngine implements EngineFacade {
  readonly #repo: Repo;
  readonly #snapshots: SnapshotStore;
  readonly #secrets: SecretsStore;
  readonly #dataDir: string;
  readonly #resolveAdapter: (modelConfigId: string | null) => ModelAdapter;
  readonly #runtimes = new Map<string, TaskRuntime>();
  readonly #approvalWaiters = new Map<string, { taskId: string; resolve: (a: ApprovalAnswer) => void }>();

  constructor(deps: EngineDeps) {
    this.#repo = deps.repo;
    this.#snapshots = deps.snapshots;
    this.#secrets = deps.secrets;
    this.#dataDir = deps.dataDir;
    this.#resolveAdapter = deps.resolveAdapter;
  }

  // ---------------------------------------------------------------- 提交与队列

  async submitTask(input: SubmitTaskInput): Promise<{ task: Task; deduplicated: boolean }> {
    const existing = this.#repo.tasks.findByClientRequestId(input.projectId, input.clientRequestId);
    if (existing) {
      return { task: existing, deduplicated: true };
    }
    const task = this.#repo.tasks.create({
      projectId: input.projectId,
      sessionId: input.sessionId,
      input: input.input,
      clientRequestId: input.clientRequestId,
      modelConfigId: input.modelConfigId ?? null,
      approvalMode: input.approvalMode ?? 'manual',
      requesterDeviceId: input.requesterDeviceId ?? null,
    });
    this.#schedule(input.projectId);
    return { task, deduplicated: false };
  }

  /** 同项目串行：有活动任务则等待；否则取下一个 queued 启动 */
  #schedule(projectId: string): void {
    const tasks = this.#repo.tasks.listByProject(projectId);
    const active = tasks.some(
      t => t.state === 'running' || t.state === 'awaiting_input'
        || t.state === 'awaiting_approval' || t.state === 'stopping',
    );
    if (active) return;
    const next = this.#repo.tasks.nextQueued(projectId);
    if (!next) return;
    this.#runTask(next.id).catch(() => {
      // runTask 内部已兜底；此处仅为防止未处理拒绝
    });
  }

  // ---------------------------------------------------------------- 执行循环

  async #runTask(taskId: string): Promise<void> {
    const task = this.#repo.tasks.getById(taskId);
    if (!task || task.state !== 'queued') return;
    const project = this.#repo.projects.getById(task.projectId);
    if (!project) {
      this.#repo.tasks.updateState(taskId, 'running');
      this.#failTask(taskId, '任务所属项目不存在');
      return;
    }

    const runtime: TaskRuntime = {
      messages: [
        { role: 'system', content: systemPrompt(project.path) },
        { role: 'user', content: task.input },
      ],
      abort: new AbortController(),
      stopRequested: false,
      child: null,
      projectRoot: project.path,
      totalUsage: { promptTokens: 0, completionTokens: 0 },
    };
    this.#runtimes.set(taskId, runtime);
    this.#repo.tasks.updateState(taskId, 'running');

    let adapter: ModelAdapter;
    try {
      adapter = this.#resolveAdapter(task.modelConfigId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#repo.tasks.updateSummary(taskId, `模型不可用: ${redactText(msg)}`);
      this.#repo.tasks.updateState(taskId, 'blocked');
      this.#runtimes.delete(taskId);
      this.#schedule(project.id);
      return;
    }

    try {
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        if (runtime.stopRequested) throw new StopRequested();
        let result: ModelTurnResult;
        try {
          result = await adapter.chat(runtime.messages, TOOL_SPECS, runtime.abort.signal);
        } catch (err) {
          if (runtime.stopRequested || isAbortError(err)) throw new StopRequested();
          throw err;
        }

        if (result.usage) {
          runtime.totalUsage.promptTokens += result.usage.promptTokens;
          runtime.totalUsage.completionTokens += result.usage.completionTokens;
          this.#repo.events.append(project.id, taskId, 'task.message', {
            taskId,
            usage: { ...runtime.totalUsage },
          });
        }

        if (result.text || result.reasoningSummary) {
          this.#repo.events.append(project.id, taskId, 'task.message', {
            text: redactText(result.text), reasoningSummary: redactText(result.reasoningSummary ?? ''), turn: turn + 1,
          });
        }
        const assistantMsg: ChatMessage = { role: 'assistant', content: result.text };
        if (result.responseItems) assistantMsg.responseItems = result.responseItems;
        if (result.toolCalls.length > 0) assistantMsg.toolCalls = result.toolCalls;
        runtime.messages.push(assistantMsg);

        if (result.toolCalls.length === 0) {
          this.#completeTask(taskId, result.text.trim() !== '' ? result.text : '任务完成');
          return;
        }

        for (const call of result.toolCalls) {
          if (runtime.stopRequested) throw new StopRequested();
          const outcome = await this.#handleToolCall(project, taskId, runtime, call);
          runtime.messages.push({ role: 'tool', content: outcome.text, toolCallId: call.id });
          if (outcome.finished) return;
        }
      }
      this.#failTask(taskId, `超过最大对话轮次 ${MAX_TURNS}，任务终止`);
    } catch (err) {
      if (err instanceof StopRequested || isAbortError(err)) {
        this.#finishStopped(taskId);
        return;
      }
      const status = (err as { status?: unknown }).status;
      const msg = err instanceof Error ? err.message : String(err);
      if (status === 401 || status === 403) {
        this.#blockTask(taskId, `模型认证失败: ${redactText(msg)}`);
      } else {
        this.#failTask(taskId, `执行出错: ${redactText(msg)}`);
      }
    } finally {
      this.#runtimes.delete(taskId);
      this.#schedule(project.id);
    }
  }

  // ---------------------------------------------------------------- 工具调度

  async #handleToolCall(
    project: Project,
    taskId: string,
    runtime: TaskRuntime,
    call: { name: ToolName; args: Record<string, unknown> },
  ): Promise<{ text: string; finished: boolean }> {
    const redacted = redactArgs(call.args);
    const seq = this.#repo.toolCalls.listByTask(taskId).length + 1;
    const tc = this.#repo.toolCalls.create({ taskId, seq, tool: call.name, args: redacted });
    this.#repo.events.append(project.id, taskId, 'tool.start', {
      taskId, toolCallId: tc.id, tool: call.name, args: redacted,
    });

    const finish = (state: ToolCallState, text: string, finished = false): { text: string; finished: boolean } => {
      this.#repo.toolCalls.updateState(tc.id, state);
      this.#repo.toolCalls.updateResult(tc.id, truncate(text, RESULT_STORE_LIMIT, '结果过长已截断'));
      this.#repo.events.append(project.id, taskId, 'tool.end', {
        taskId, toolCallId: tc.id, tool: call.name, state,
        result: truncate(text, 2000, '结果过长已截断'),
      });
      return { text, finished };
    };

    const decision = decidePermission(call.name, call.args, project.path, this.#repo.tasks.getById(taskId)?.approvalMode);

    if (decision.kind === 'deny') {
      return finish('failed', `操作被权限策略拒绝: ${decision.reason}`);
    }

    if (decision.kind === 'requires_approval') {
      const approval = this.#repo.approvals.create({
        taskId,
        toolCallId: tc.id,
        operation: describeOperation(call.name, call.args),
        params: redacted,
        reason: decision.reason,
        riskSummary: decision.riskSummary,
      });
      this.#repo.toolCalls.updateState(tc.id, 'awaiting_approval');
      this.#repo.tasks.updateState(taskId, 'awaiting_approval');
      const answer = await new Promise<ApprovalAnswer>(resolve => {
        this.#approvalWaiters.set(approval.id, { taskId, resolve });
      });
      if (runtime.stopRequested) throw new StopRequested();
      this.#repo.tasks.updateState(taskId, 'running');
      if (answer.decision === 'reject') {
        return finish('rejected', `用户拒绝了该操作${answer.note !== null ? `：${answer.note}` : ''}`);
      }
      // approved：继续向下执行
    }

    this.#repo.toolCalls.updateState(tc.id, 'running');
    try {
      const out = await this.#executeTool(project.id, taskId, runtime, call.name, call.args);
      if (out.finished) {
        this.#repo.toolCalls.updateState(tc.id, 'done');
        this.#repo.toolCalls.updateResult(tc.id, truncate(out.text, RESULT_STORE_LIMIT, '结果过长已截断'));
        this.#repo.events.append(project.id, taskId, 'tool.end', {
          taskId, toolCallId: tc.id, tool: call.name, state: 'done', result: out.text.slice(0, 2000),
        });
        this.#completeTask(taskId, out.text);
        return { text: out.text, finished: true };
      }
      return finish('done', out.text);
    } catch (err) {
      if (runtime.stopRequested || isAbortError(err)) throw new StopRequested();
      const msg = err instanceof Error ? err.message : String(err);
      return finish('failed', `工具执行失败: ${redactText(msg)}`);
    }
  }

  async #executeTool(
    projectId: string,
    taskId: string,
    runtime: TaskRuntime,
    tool: ToolName,
    args: Record<string, unknown>,
  ): Promise<{ text: string; finished: boolean }> {
    switch (tool) {
      case 'read_file': {
        const abs = resolveTarget(runtime.projectRoot, strArg(args, 'path'));
        const content = fs.readFileSync(abs, 'utf8');
        return { text: truncate(content, FILE_READ_LIMIT, '文件内容过长已截断'), finished: false };
      }
      case 'write_file': {
        const abs = resolveTarget(runtime.projectRoot, strArg(args, 'path'));
        const content = typeof args.content === 'string' ? args.content : '';
        this.#snapshots.recordBeforeWrite(taskId, projectId, abs);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        this.#snapshots.recordAfterWrite(taskId, abs);
        return { text: `已写入 ${String(args.path)}（${Buffer.byteLength(content)} 字节）`, finished: false };
      }
      case 'delete_file': {
        const abs = resolveTarget(runtime.projectRoot, strArg(args, 'path'));
        this.#snapshots.recordBeforeWrite(taskId, projectId, abs);
        removePath(abs);
        this.#snapshots.recordAfterWrite(taskId, abs, { deleted: true });
        return { text: `已删除 ${String(args.path)}`, finished: false };
      }
      case 'search': {
        return { text: runSearch(runtime.projectRoot, args), finished: false };
      }
      case 'run_command': {
        const command = strArg(args, 'command');
        const cwd = resolveWithin(runtime.projectRoot, typeof args.cwd === 'string' ? args.cwd : '.');
        const r = await this.#runCommand(command, cwd, runtime);
        const output = redactText(
          r.output.length > COMMAND_OUTPUT_LIMIT ? r.output.slice(-COMMAND_OUTPUT_LIMIT) : r.output,
        );
        const header = r.timedOut ? '命令超时（60s）已终止\n' : `退出码 ${r.code ?? 'unknown'}\n`;
        return { text: header + output, finished: false };
      }
      case 'finish': {
        const summary =
          typeof args.summary === 'string' && args.summary.trim() !== '' ? args.summary : '任务完成';
        return { text: summary, finished: true };
      }
    }
  }

  #runCommand(
    command: string,
    cwd: string,
    runtime: TaskRuntime,
  ): Promise<{ code: number | null; output: string; timedOut: boolean }> {
    return new Promise(resolve => {
      let settled = false;
      let output = '';
      let timedOut = false;
      let child: ChildProcess;
      // Windows 默认代码页非 UTF-8，前缀 chcp 使命令输出以 UTF-8 编码，与解码端一致
      const fullCommand = process.platform === 'win32'
        ? `chcp 65001 >nul & ${command}`
        : command;
      try {
        child = spawn(fullCommand, {
          shell: true,
          cwd,
          signal: runtime.abort.signal,
          windowsHide: true,
        });
      } catch {
        resolve({ code: null, output: '', timedOut: false });
        return;
      }
      runtime.child = child;
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        runtime.child = null;
        resolve({ code, output, timedOut });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, COMMAND_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: Buffer) => {
        if (output.length < 64 * 1024) output += d.toString('utf8');
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (output.length < 64 * 1024) output += d.toString('utf8');
      });
      child.on('error', () => done(null));
      child.on('close', code => done(code));
    });
  }

  // ---------------------------------------------------------------- 状态收尾

  #completeTask(taskId: string, summary: string): void {
    const t = this.#repo.tasks.getById(taskId);
    if (!t || t.state !== 'running') return;
    this.#repo.tasks.updateSummary(taskId, summary);
    this.#repo.tasks.updateState(taskId, 'completed');
  }

  #failTask(taskId: string, summary: string): void {
    const t = this.#repo.tasks.getById(taskId);
    if (!t || t.state !== 'running') return;
    this.#repo.tasks.updateSummary(taskId, summary);
    this.#repo.tasks.updateState(taskId, 'failed');
  }

  #blockTask(taskId: string, summary: string): void {
    const t = this.#repo.tasks.getById(taskId);
    if (!t || t.state !== 'running') return;
    this.#repo.tasks.updateSummary(taskId, summary);
    this.#repo.tasks.updateState(taskId, 'blocked');
  }

  #finishStopped(taskId: string): void {
    const t = this.#repo.tasks.getById(taskId);
    if (!t) return;
    if (t.state === 'stopping') {
      this.#repo.tasks.updateState(taskId, 'stopped');
    } else if (
      t.state === 'running' || t.state === 'awaiting_input' || t.state === 'awaiting_approval'
    ) {
      this.#repo.tasks.updateState(taskId, 'stopping');
      this.#repo.tasks.updateState(taskId, 'stopped');
    }
  }

  // ---------------------------------------------------------------- 用户交互

  async appendMessage(taskId: string, text: string): Promise<Task> {
    const task = this.#getTask(taskId);
    if (task.state === 'queued') {
      const updated = this.#repo.tasks.updateInput(taskId, `${task.input}\n\n【用户补充要求】${text}`);
      this.#repo.events.append(task.projectId, taskId, 'task.appended', { taskId, text: text.slice(0, 500) });
      return Promise.resolve(updated);
    }
    if (task.state === 'running' || task.state === 'awaiting_input' || task.state === 'awaiting_approval') {
      const runtime = this.#runtimes.get(taskId);
      if (!runtime) {
        throw new RepoError(ERR.INVALID_STATE, `任务 ${taskId} 不在执行中，无法追加`);
      }
      runtime.messages.push({ role: 'user', content: `【用户补充要求】${text}` });
      this.#repo.events.append(task.projectId, taskId, 'task.appended', { taskId, text: text.slice(0, 500) });
      return Promise.resolve(this.#getTask(taskId));
    }
    throw new RepoError(ERR.INVALID_STATE, `任务状态 ${task.state} 不允许追加消息`);
  }

  async answerTask(taskId: string, text: string): Promise<Task> {
    const task = this.#getTask(taskId);
    if (task.state !== 'awaiting_input') {
      throw new RepoError(ERR.INVALID_STATE, `任务状态 ${task.state} 不是 awaiting_input`);
    }
    const runtime = this.#runtimes.get(taskId);
    if (!runtime) {
      throw new RepoError(ERR.INVALID_STATE, `任务 ${taskId} 不在执行中，无法回答`);
    }
    runtime.messages.push({ role: 'user', content: `【用户回答】${text}` });
    this.#repo.events.append(task.projectId, taskId, 'task.appended', { taskId, kind: 'answer', text: text.slice(0, 500) });
    return Promise.resolve(this.#repo.tasks.updateState(taskId, 'running'));
  }

  async stopTask(taskId: string): Promise<Task> {
    const task = this.#getTask(taskId);
    if (task.state === 'queued') return this.cancelQueued(taskId);
    if (TERMINAL_STATES.includes(task.state)) {
      return Promise.resolve(task); // 幂等停止：已终态任务直接返回当前状态（多设备并发停止均成功）
    }
    if (task.state === 'stopping') return Promise.resolve(task);

    const runtime = this.#runtimes.get(taskId);
    if (runtime) {
      runtime.stopRequested = true;
      runtime.abort.abort();
      if (runtime.child) killProcessTree(runtime.child);
      for (const [id, w] of this.#approvalWaiters) {
        if (w.taskId === taskId) {
          this.#approvalWaiters.delete(id);
          w.resolve({ decision: 'reject', note: '任务已停止' });
        }
      }
    }
    const updated = this.#repo.tasks.updateState(taskId, 'stopping');
    if (!runtime) {
      // 无活动运行时（异常残留状态），直接落到 stopped
      return Promise.resolve(this.#repo.tasks.updateState(taskId, 'stopped'));
    }
    // 执行循环收到 abort 后异步落到 stopped；已经发生的修改保留，不自动撤销
    return Promise.resolve(updated);
  }

  async cancelQueued(taskId: string): Promise<Task> {
    const task = this.#getTask(taskId);
    if (task.state !== 'queued') {
      throw new RepoError(ERR.INVALID_STATE, `任务状态 ${task.state} 不是 queued，无法取消排队`);
    }
    return Promise.resolve(this.#repo.tasks.updateState(taskId, 'stopped'));
  }

  async decideApproval(approvalId: string, decision: 'approve' | 'reject', note?: string): Promise<Approval> {
    const approval = this.#repo.approvals.decide(approvalId, decision, note ?? null);
    const waiter = this.#approvalWaiters.get(approvalId);
    if (waiter) {
      this.#approvalWaiters.delete(approvalId);
      waiter.resolve({ decision, note: note ?? null });
    }
    return Promise.resolve(approval);
  }

  async setApprovalMode(taskId: string, mode: import('../types.ts').ApprovalMode): Promise<Task> {
    const task = this.#getTask(taskId);
    if (!['manual', 'auto', 'full'].includes(mode)) throw new RepoError(ERR.VALIDATION, 'Invalid approval mode');
    if (TERMINAL_STATES.includes(task.state)) throw new RepoError(ERR.INVALID_STATE, 'Task already ended');
    this.#repo.tasks.setApprovalMode(taskId, mode);
    this.#repo.events.append(task.projectId, taskId, 'task.changed', { taskId, approvalMode: mode });
    this.#repo.events.append(task.projectId, taskId, 'task.message', { text: `Approval mode: ${mode}` });
    // Persist first; releasing a waiter can immediately start the next tool.
    if (mode !== 'manual') {
      for (const approval of this.#repo.approvals.pendingByTask(taskId)) {
        await this.decideApproval(approval.id, 'approve', `Task approval mode: ${mode}`);
      }
    }
    return this.#getTask(taskId);
  }

  async undoTask(taskId: string): Promise<UndoReport> {
    const task = this.#getTask(taskId);
    if (!TERMINAL_STATES.includes(task.state)) {
      throw new RepoError(ERR.INVALID_STATE, `仅终态任务可撤销，当前状态 ${task.state}`);
    }
    const report = this.#snapshots.undo(taskId);
    this.#repo.events.append(task.projectId, taskId, 'task.changed', {
      taskId,
      kind: 'undo',
      hasConflict: report.hasConflict,
      files: report.results.length,
    });
    return Promise.resolve(report);
  }

  async resumeInterrupted(taskId: string): Promise<Task> {
    const task = this.#getTask(taskId);
    if (task.state !== 'interrupted') {
      throw new RepoError(ERR.INVALID_STATE, `任务状态 ${task.state} 不是 interrupted`);
    }
    this.#repo.tasks.updateSummary(taskId, task.summary !== null ? `${task.summary}\n${RESUME_NOTE}` : RESUME_NOTE);
    const updated = this.#repo.tasks.updateState(taskId, 'queued');
    this.#schedule(task.projectId);
    return Promise.resolve(updated);
  }

  /** 服务启动恢复：非终态任务（queued 除外）置为 interrupted，queued 保留并继续调度 */
  recoverOnBoot(): void {
    for (const project of this.#repo.projects.list()) {
      for (const task of this.#repo.tasks.listByProject(project.id)) {
        if (
          task.state === 'running' || task.state === 'awaiting_input'
          || task.state === 'awaiting_approval' || task.state === 'stopping'
        ) {
          this.#repo.tasks.updateState(task.id, 'interrupted');
        }
      }
      this.#schedule(project.id);
    }
  }

  #getTask(taskId: string): Task {
    const task = this.#repo.tasks.getById(taskId);
    if (!task) throw new RepoError(ERR.NOT_FOUND, `task not found: ${taskId}`);
    return task;
  }
}
