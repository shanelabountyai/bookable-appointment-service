/**
 * The model behind the eval loop (PRD §9.7), behind one small interface so
 * the harness can be exercised in CI without spending a cent: `ClaudeModel`
 * calls the Messages API; `ScriptedModel` replays a fixed list of tool calls.
 *
 * Both return the SDK's own `Message` shape, so the loop in harness.ts is the
 * same code either way.
 */
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** USD per million tokens. Anthropic first-party rates, 2026-10. Unknown ids fall back to the Opus row — conservative. */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export function costUsd(model: string, usage: Anthropic.Usage): number {
  const p = PRICING[model] ?? PRICING[DEFAULT_MODEL]!;
  const perTok = (rate: number) => rate / 1_000_000;
  return (
    usage.input_tokens * perTok(p.input) +
    usage.output_tokens * perTok(p.output) +
    (usage.cache_read_input_tokens ?? 0) * perTok(p.cacheRead) +
    (usage.cache_creation_input_tokens ?? 0) * perTok(p.input) * 1.25
  );
}

export interface Model {
  readonly id: string;
  next(args: { system: string; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }): Promise<Anthropic.Message>;
}

export class ClaudeModel implements Model {
  private readonly client = new Anthropic();
  constructor(readonly id: string = process.env.EVAL_MODEL ?? DEFAULT_MODEL) {}

  async next({ system, messages, tools }: Parameters<Model['next']>[0]): Promise<Anthropic.Message> {
    // Adaptive thinking is the default on this generation; no forced tool_choice (400 on Opus 5.5).
    return this.client.messages.create({
      model: this.id,
      max_tokens: 8000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });
  }
}

/** One scripted step: which tool to call, with args built from the scenario's ids and the previous tool's structured result. */
export type Step = (ids: Record<string, string>, last: Record<string, unknown> | null) => { tool: string; args: Record<string, unknown> };

/**
 * Replays `steps` one tool call per turn, then ends. Reads the previous
 * `tool_result` off the conversation exactly as a model would, so a step can
 * use the proposal_id the step before it produced. Reports zero usage.
 */
export class ScriptedModel implements Model {
  readonly id = 'scripted';
  private i = 0;
  constructor(
    private readonly steps: readonly Step[],
    private readonly ids: Record<string, string>,
    private readonly finalText = 'Done.',
  ) {}

  async next({ messages }: Parameters<Model['next']>[0]): Promise<Anthropic.Message> {
    const step = this.steps[this.i];
    const last = lastToolResult(messages);
    const content: Anthropic.ContentBlock[] = step
      ? [{ type: 'tool_use', id: `step-${this.i}`, name: step(this.ids, last).tool, input: step(this.ids, last).args } as Anthropic.ToolUseBlock]
      : [{ type: 'text', text: this.finalText, citations: null } as Anthropic.TextBlock];
    this.i++;
    return {
      id: `scripted-${this.i}`,
      type: 'message',
      role: 'assistant',
      model: this.id,
      content,
      stop_reason: step ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage,
    } as Anthropic.Message;
  }
}

function lastToolResult(messages: Anthropic.MessageParam[]): Record<string, unknown> | null {
  const last = messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.content === 'string') return null;
  const block = [...last.content].reverse().find((b) => b.type === 'tool_result');
  if (!block || block.type !== 'tool_result' || typeof block.content === 'string') return null;
  const text = block.content?.find((c) => c.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    return JSON.parse(text.text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
