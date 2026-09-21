import path from 'node:path';
import type { PermissionDecision, ToolName } from '../types.ts';
import { isSensitivePath, resolveWithin } from '../util/paths.ts';

const AUTO: PermissionDecision = { kind: 'auto' };

function approval(reason: string, riskSummary: string): PermissionDecision {
  return { kind: 'requires_approval', reason, riskSummary };
}

function deny(reason: string): PermissionDecision {
  return { kind: 'deny', reason };
}

function tryResolveWithin(root: string, p: string): string | null {
  try {
    return resolveWithin(root, p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 文件类工具

function decideFileTool(tool: ToolName, args: Record<string, unknown>, root: string): PermissionDecision {
  const raw =
    typeof args.path === 'string' ? args.path :
    typeof args.file === 'string' ? args.file : null;
  if (raw === null) {
    // search 不带 path 时默认在项目根内搜索
    if (tool === 'search') return AUTO;
    return approval('缺少路径参数，无法判定操作目标', '无法确认影响范围');
  }

  const sensitive = isSensitivePath(raw);
  if (tool === 'read_file' || tool === 'search') {
    if (sensitive) {
      return approval('目标为敏感文件', `读取 ${raw} 可能泄露凭据/密钥`);
    }
    if (tryResolveWithin(root, raw) === null) {
      return approval('目标路径在项目根目录之外', `读取项目外路径 ${raw}`);
    }
    return AUTO;
  }

  // write_file / delete_file
  if (sensitive) {
    return deny(`禁止操作敏感文件: ${raw}`);
  }
  const resolved = tryResolveWithin(root, raw);
  if (resolved === null) {
    return approval('目标路径在项目根目录之外', `将修改项目外路径 ${raw}`);
  }
  if (isSensitivePath(resolved)) {
    return deny(`禁止操作敏感文件: ${raw}`);
  }
  if (tool === 'delete_file') {
    return approval('删除文件为破坏性操作', `将删除 ${raw}，可从快照恢复`);
  }
  return AUTO; // 项目内 write auto（快照由调用方保证）
}

// ---------------------------------------------------------------- run_command

const DANGEROUS: { re: RegExp; summary: string }[] = [
  { re: /\bsudo\b/, summary: '命令包含 sudo，将以管理员权限执行' },
  { re: /\brm\s+-[A-Za-z]*r[A-Za-z]*\b/i, summary: '递归强制删除文件，可能不可恢复' },
  { re: /\bmkfs\b/, summary: '格式化文件系统，将销毁磁盘数据' },
  { re: /\bdd\s+/, summary: 'dd 直接读写磁盘/设备，可能销毁数据' },
  { re: /:\s*\(\s*\)\s*\{/, summary: '疑似 fork 炸弹，将耗尽系统资源' },
  { re: />\s*\/dev\/sd/, summary: '直接写入磁盘设备，将销毁数据' },
  { re: /\bgit\s+push\b/, summary: '推送提交到远端，撤销不影响远端' },
  { re: /\bgit\s+reset\s+--hard\b/, summary: '硬重置将丢弃未提交的修改' },
  { re: /\bgit\s+clean\s+-[A-Za-z]*f/, summary: '将删除未跟踪文件，不可恢复' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?[a-z]*sh\b/, summary: '下载并直接执行远程脚本，内容不可审计' },
  { re: /\b(npm|pnpm|yarn)\s+(install|i|add)\b/, summary: '安装/变更依赖，会修改 node_modules 与锁文件' },
  { re: /\bapt(-get)?\s+install\b/, summary: '安装系统软件包，影响整机环境' },
  { re: /\bpip3?\s+install\b/, summary: '安装 Python 依赖，影响解释器环境' },
  // Windows 等价危险操作
  { re: /\bformat\b\s+[a-z]:/i, summary: '格式化磁盘，将销毁数据' },
  { re: /\brd\b[^|]*\/s\b/i, summary: '递归删除目录树，可能不可恢复' },
  { re: /\bdel\b[^|]*\/s\b/i, summary: '递归删除文件，可能不可恢复' },
  { re: /\bremove-item\b[^|]*-recurse\b/i, summary: 'PowerShell 递归删除，可能不可恢复' },
  { re: /\brmdir\b[^|]*\/s\b/i, summary: '递归删除目录树，可能不可恢复' },
  { re: /\breg\s+(add|delete|import)\b/i, summary: '修改系统注册表，影响整机环境' },
  { re: /-encodedcommand\b/i, summary: 'PowerShell Base64 隐藏载荷，内容不可审计' },
  { re: /\b(iwr|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(iex|invoke-expression)\b/i, summary: '下载并直接执行远程脚本，内容不可审计' },
  { re: /\bshutdown\b|\brestart-computer\b/i, summary: '关机/重启主机' },
  { re: /\bnet\s+user\b|\bnet\s+localgroup\b/i, summary: '修改系统用户/组，影响整机环境' },
  { re: /\bsc\s+(create|delete|config)\b/i, summary: '修改系统服务，影响整机环境' },
  { re: /\bbcdedit\b/i, summary: '修改启动配置，可导致系统无法启动' },
  { re: /\bwinget\s+install\b|\bchoco\s+install\b/i, summary: '安装系统软件包，影响整机环境' },
];

const SAFE_SIMPLE = new Set([
  'ls', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'pwd', 'echo',
  'find', 'sort', 'uniq', 'diff', 'which', 'tree', 'stat', 'file',
  // Windows cmd/PowerShell 只读等价命令
  'dir', 'type', 'findstr', 'where', 'cls', 'get-childitem', 'get-content',
  'get-item', 'get-location', 'measure-object', 'select-string', 'get-help',
]);
const SAFE_GIT_SUB = new Set(['status', 'diff', 'log', 'show', 'branch']);
const SAFE_RUN_SCRIPT = new Set(['build', 'lint', 'typecheck', 'test']);

function isSafeSegment(seg: string): boolean {
  const tokens = seg.split(/\s+/).filter(Boolean);
  const firstRaw = tokens[0];
  if (!firstRaw) return false;
  const first = path.basename(firstRaw).toLowerCase();
  if (SAFE_SIMPLE.has(first)) return true;
  if (first === 'git') {
    return tokens.length >= 2 && SAFE_GIT_SUB.has(tokens[1]!);
  }
  if (first === 'npm' || first === 'pnpm' || first === 'yarn') {
    const sub = tokens[1];
    if (sub === 'test') return true;
    if (sub === 'run' && tokens[2] !== undefined && SAFE_RUN_SCRIPT.has(tokens[2])) return true;
    if ((first === 'pnpm' || first === 'yarn') && sub !== undefined && SAFE_RUN_SCRIPT.has(sub)) return true;
    return false;
  }
  if (first === 'node' || first === 'python' || first === 'python3' || first === 'tsc') {
    return true; // 路径越界已在统一检查中拦截
  }
  return false;
}

function decideCommand(args: Record<string, unknown>, root: string): PermissionDecision {
  const cmd = typeof args.command === 'string' ? args.command : null;
  if (cmd === null || cmd.trim() === '') {
    return approval('缺少命令参数，无法判定', '无法确认命令影响');
  }

  for (const { re, summary } of DANGEROUS) {
    if (re.test(cmd)) {
      return approval('命令包含高风险操作', summary);
    }
  }

  if (/\bcd\s+\.{2}([\\/]|\s|$)/.test(cmd)) {
    return approval('命令切换到上级目录', '目标可能越出项目根目录');
  }

  // 逐 token 检查路径越界：绝对路径在项目外、或含 .. 段的相对路径
  for (const token of cmd.split(/\s+/)) {
    if (token === '' || token.startsWith('-')) continue;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(token)) {
      return approval('命令包含指向上级目录的路径', `路径 ${token} 可能越出项目根目录`);
    }
    if (token.startsWith('/') || /^[A-Za-z]:[\\/]/.test(token) || token.startsWith('\\\\') || /^\\[^\\]/.test(token)) {
      if (tryResolveWithin(root, token) === null) {
        return approval('命令包含项目外的绝对路径', `路径 ${token} 在项目根目录之外`);
      }
    }
  }

  // cmd 的单 & 顺序分隔符与 POSIX 分隔符一并切分（&& 已被前面消费，剩余单 & 可安全切分）
  const segments = cmd
    .split(/&&|\|\||;|\||\n/)
    .flatMap(s => s.split('&'))
    .map(s => s.trim())
    .filter(Boolean);
  if (segments.length > 0 && segments.every(isSafeSegment)) {
    return AUTO;
  }
  return approval('无法确认命令安全性', '命令不在明确的只读/构建白名单内，需人工确认');
}

// ---------------------------------------------------------------- 入口

function decideBaselinePermission(
  tool: ToolName,
  args: Record<string, unknown>,
  projectRoot: string,
): PermissionDecision {
  switch (tool) {
    case 'read_file':
    case 'search':
    case 'write_file':
    case 'delete_file':
      return decideFileTool(tool, args, projectRoot);
    case 'run_command':
      return decideCommand(args, projectRoot);
    case 'finish':
      return AUTO;
  }
}

/** Mode is captured per submitted task; it never depends on a connected phone. */
export function decidePermission(tool: ToolName, args: Record<string, unknown>, root: string,
  mode: import('../types.ts').ApprovalMode = 'manual'): PermissionDecision {
  const baseline = decideBaselinePermission(tool, args, root);
  if (mode === 'full') return AUTO;
  if (mode === 'auto' && baseline.kind === 'requires_approval') return AUTO;
  return baseline;
}
