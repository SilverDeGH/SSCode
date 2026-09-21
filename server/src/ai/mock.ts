import type { ChatMessage, ModelAdapter, ModelTurnResult, ToolName, ToolSpec } from '../types.ts';

export interface MockTurn {
  text?: string;
  toolCalls?: { name: ToolName; args: Record<string, unknown> }[];
}

/** 脚本化 mock 模型适配器：每次 chat 消费一条脚本，耗尽后自动 finish */
export class MockAdapter implements ModelAdapter {
  #script: readonly MockTurn[];
  #cursor = 0;
  #seq = 0;

  constructor(script: readonly MockTurn[]) {
    this.#script = script;
  }

  #nextId(): string {
    this.#seq += 1;
    return `mock-call-${this.#seq}`;
  }

  chat(_messages: ChatMessage[], _tools: ToolSpec[], _signal: AbortSignal): Promise<ModelTurnResult> {
    const turn = this.#script[this.#cursor];
    if (turn === undefined) {
      return Promise.resolve({
        text: '（mock 脚本已结束）',
        toolCalls: [{ id: this.#nextId(), name: 'finish', args: { summary: 'mock 完成' } }],
        usage: null,
      });
    }
    this.#cursor += 1;
    return Promise.resolve({
      text: turn.text ?? '',
      toolCalls: (turn.toolCalls ?? []).map(tc => ({ id: this.#nextId(), name: tc.name, args: tc.args })),
      usage: null,
    });
  }

  test(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: true, detail: 'mock adapter 可用' });
  }
}
