import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ModelAdapter,
  ModelConfig,
  ModelTurnResult,
  ToolName,
  ToolSpec,
} from '../types.ts';
import { redactText } from '../util/redact.ts';
import type { SecretsStore } from './secrets.ts';
import { TOOL_SPECS } from './toolspec.ts';

const VALID_TOOLS = new Set<string>([
  'read_file', 'write_file', 'delete_file', 'search', 'run_command', 'finish',
]);

export type ModelErrorCategory = 'auth' | 'rate_limit' | 'server' | 'network' | 'http';

export class ModelRequestError extends Error {
  readonly status: number | null;
  readonly category: ModelErrorCategory;

  constructor(message: string, status: number | null, category: ModelErrorCategory) {
    super(message);
    this.name = 'ModelRequestError';
    this.status = status;
    this.category = category;
  }
}

function toOpenAiMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map(m => {
    const out: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === 'tool' && m.toolCallId !== undefined) {
      out.tool_call_id = m.toolCallId;
    }
    if (m.role === 'assistant' && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      }));
    }
    return out;
  });
}

function toOpenAiTools(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** OpenAI 兼容接口适配器（chat/completions，非流式） */
export class OpenAiCompatAdapter implements ModelAdapter {
  #baseUrl: string;
  #model: string;
  #apiKey: string;
  #responses: boolean;

  constructor(opts: { baseUrl: string; model: string; apiKey: string }) {
    const endpoint = opts.baseUrl.trim().replace(/\/+$/, '');
    this.#responses = endpoint.endsWith('/responses') || (!endpoint.endsWith('/chat/completions') && /^gpt-?6/i.test(opts.model));
    this.#baseUrl = endpoint.replace(/\/(responses|chat\/completions)$/, '');
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelTurnResult> {
    if (this.#responses) return this.#chatResponses(messages, tools, signal);
    const body = {
      model: this.#model,
      messages: toOpenAiMessages(messages),
      tools: toOpenAiTools(tools),
      stream: false,
    };
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const msg = err instanceof Error ? `${err.message}${err.cause ? ` (${String(err.cause)})` : ''}` : String(err);
      throw new ModelRequestError(`模型请求网络错误: ${redactText(msg)}`, null, 'network');
    }
    if (!res.ok) {
      const respText = await res.text().catch(() => '');
      const category: ModelErrorCategory =
        res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'rate_limit'
        : res.status >= 500 ? 'server'
        : 'http';
      throw new ModelRequestError(
        `模型接口错误 HTTP ${res.status} (${category}): ${redactText(respText.slice(0, 300))}`,
        res.status,
        category,
      );
    }
    const data = (await res.json()) as ChatCompletionResponse;

    const u = data.usage;
    const usage =
      u !== null && u !== undefined &&
      typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number'
        ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens }
        : null;

    const message = data.choices?.[0]?.message;
    if (!message) throw new ModelRequestError('Missing choices/message; check API protocol and endpoint', res.status, 'http');
    let text = typeof message.content === 'string' ? message.content : '';
    const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const toolCalls: ModelTurnResult['toolCalls'] = [];

    for (const raw of rawCalls) {
      const c = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const name = typeof c.function?.name === 'string' ? c.function.name : '';
      const argsText = typeof c.function?.arguments === 'string' ? c.function.arguments : '{}';
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(argsText);
        args =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        text += `\n[工具调用参数 JSON 解析失败，本轮按纯文本处理: ${argsText.slice(0, 200)}]`;
        return { text, toolCalls: [], usage };
      }
      if (!VALID_TOOLS.has(name)) {
        text += `\n[模型请求了未知工具 ${name}，本轮按纯文本处理]`;
        return { text, toolCalls: [], usage };
      }
      toolCalls.push({
        id: typeof c.id === 'string' ? c.id : randomUUID(),
        name: name as ToolName,
        args,
      });
    }
    return { text, toolCalls, usage };
  }

  async #chatResponses(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelTurnResult> {
    const input: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'assistant' && m.responseItems) { input.push(...m.responseItems); continue; }
      if (m.role === 'tool') { input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content }); continue; }
      if (m.content) input.push({ role: m.role, content: m.content });
      for (const call of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) });
    }
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}/responses`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({ model: this.#model, input, store: false, stream: false,
          include: ['reasoning.encrypted_content'], reasoning: { summary: 'auto' },
          tools: tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ModelRequestError(`Responses network error: ${redactText(String(err))}`, null, 'network');
    }
    if (!res.ok) {
      const category: ModelErrorCategory = res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : 'http';
      throw new ModelRequestError(`Responses HTTP ${res.status}: ${redactText((await res.text()).slice(0, 500))}`, res.status, category);
    }
    const data = await res.json() as { status?: string; output?: Record<string, unknown>[]; usage?: { input_tokens: number; output_tokens: number }; error?: unknown };
    if (data.error || (data.status && data.status !== 'completed') || !Array.isArray(data.output) || data.output.length === 0) {
      throw new ModelRequestError(`Responses incomplete or invalid: ${redactText(JSON.stringify(data.error ?? data.status ?? 'missing output'))}`, res.status, 'http');
    }
    const toolCalls: ModelTurnResult['toolCalls'] = [];
    const texts: string[] = [], summaries: string[] = [];
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) if (c.type === 'output_text' && typeof c.text === 'string') texts.push(c.text);
      }
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const c of item.summary) if (typeof c.text === 'string') summaries.push(c.text);
      }
      if (item.type === 'function_call') {
        const name = String(item.name);
        if (!VALID_TOOLS.has(name) || typeof item.call_id !== 'string') throw new ModelRequestError('Invalid Responses tool call or arguments', res.status, 'http');
        const args: unknown = JSON.parse(String(item.arguments));
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ModelRequestError('Invalid Responses tool call or arguments', res.status, 'http');
        toolCalls.push({ id: item.call_id, name: name as ToolName, args: args as Record<string, unknown> });
      }
    }
    return { text: texts.join('\n'), reasoningSummary: summaries.join('\n'), responseItems: data.output, toolCalls,
      usage: data.usage ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens } : null };
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await this.chat(
        [{
          role: 'user',
          content: '这是一次连通性与工具调用能力测试。请只调用 finish 工具（summary 填 "ok"），不要输出其他内容。',
        }],
        TOOL_SPECS,
        controller.signal,
      );
      if (result.toolCalls.length > 0) {
        return { ok: true, detail: `连接正常，模型 ${this.#model} 可解析出工具调用` };
      }
      return {
        ok: false,
        detail: `模型 ${this.#model} 未返回工具调用（仅返回纯文本），该接口可能不支持 function calling，无法宣称可执行完整 AI 编程任务`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `连接测试失败: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 由模型配置创建适配器；API Key 从受保护存储取，取不到抛错 */
export function createAdapter(config: ModelConfig, secrets: SecretsStore): ModelAdapter {
  const apiKey = secrets.get(config.apiKeyRef);
  if (apiKey === null) {
    throw new Error(
      `模型配置「${config.name}」缺少 API Key（ref: ${config.apiKeyRef}），请先写入受保护存储`,
    );
  }
  return new OpenAiCompatAdapter({ baseUrl: config.baseUrl, model: config.model, apiKey });
}
