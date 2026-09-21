import type { ToolSpec } from '../types.ts';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'read_file',
    description: '读取项目内文件的内容，内容过长时会截断。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对项目根目录，或项目内绝对路径）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '新建或覆盖写入项目内文件，写入前会自动快照以便撤销。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对项目根目录，或项目内绝对路径）' },
        content: { type: 'string', description: '要写入的完整文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: '删除项目内文件（破坏性操作，需用户审批，可从快照恢复）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对项目根目录，或项目内绝对路径）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: '在项目内搜索匹配指定模式的文本行，返回 相对路径:行号: 内容 列表。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '搜索模式（正则表达式，非法正则按字面量处理）' },
        path: { type: 'string', description: '限定搜索的子目录或文件，默认为项目根目录' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: '在项目目录内执行 shell 命令，默认超时 60 秒，输出截断返回。高风险命令需用户审批。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        cwd: { type: 'string', description: '工作目录（相对项目根目录），默认为项目根目录' },
      },
      required: ['command'],
    },
  },
  {
    name: 'finish',
    description: '任务完成时调用，提交总结并结束任务。总结需说明：做了什么、改了哪些文件、验证结果、遗留问题。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '任务总结' },
      },
      required: ['summary'],
    },
  },
];
