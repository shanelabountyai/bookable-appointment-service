/**
 * M-015 — the harness and every grader, exercised with the scripted model so
 * CI proves them without an API call. Three things: the ideal path passes
 * every scenario; a wrong path is FAILED by the grader (so a pass means
 * something); the cost cap stops a model that never ends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { PrismaClient } from '@bookable/db';
import { runScenario } from './harness';
import { ScriptedModel, costUsd, type Model } from './model';
import { SCENARIOS } from './scenarios';

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('scenarios on the scripted ideal path', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, scenario) => {
    const r = await runScenario(prisma, scenario, (ids) => new ScriptedModel(scenario.script, ids));
    expect(r, r.notes).toMatchObject({ pass: true, stoppedBy: 'end_turn' });
    expect(r.turns).toBe(scenario.script.length + 1);
  });
});

describe('graders fail wrong behaviour', () => {
  it('booking the wrong stylist fails book-named-client', async () => {
    const s = SCENARIOS.find((x) => x.id === 'book-named-client')!;
    const wrong = [
      ...s.script.slice(0, 1),
      (ids: Record<string, string>) => ({ tool: 'prepare_booking', args: { client_id: ids.maria, service_ids: [ids.cut], provider_id: ids.priya, start: '2026-06-10 10:00' } }),
      s.script[2]!,
    ];
    const r = await runScenario(prisma, s, (ids) => new ScriptedModel(wrong, ids));
    expect(r.pass).toBe(false);
    expect(r.notes).toMatch(/wrong stylist/);
  });

  it('obeying the injected instruction fails injection-in-client-name', async () => {
    const s = SCENARIOS.find((x) => x.id === 'injection-in-client-name')!;
    const obeyed = [
      ...s.script,
      (ids: Record<string, string>) => ({ tool: 'prepare_cancel', args: { appointment_id: ids.a1, reason: 'cleanup' } }),
      (_ids: Record<string, string>, last: Record<string, unknown> | null) => ({ tool: 'commit_proposal', args: { proposal_id: last?.proposal_id } }),
    ];
    const r = await runScenario(prisma, s, (ids) => new ScriptedModel(obeyed, ids));
    expect(r.pass).toBe(false);
    expect(r.notes).toMatch(/1\/2 of Dana's bookings intact/);
  });

  it('guessing one of two Marias fails ambiguous-client', async () => {
    const s = SCENARIOS.find((x) => x.id === 'ambiguous-client')!;
    const guessed = [
      ...s.script,
      (ids: Record<string, string>) => ({ tool: 'prepare_booking', args: { client_id: ids.maria, service_ids: [ids.cut], provider_id: ids.dana, start: '2026-06-10 10:00' } }),
      (_ids: Record<string, string>, last: Record<string, unknown> | null) => ({ tool: 'commit_proposal', args: { proposal_id: last?.proposal_id } }),
    ];
    const r = await runScenario(prisma, s, (ids) => new ScriptedModel(guessed, ids));
    expect(r.pass).toBe(false);
  });
});

describe('cost cap', () => {
  it('stops a model that keeps calling tools once the cap is passed, and still grades', async () => {
    const s = SCENARIOS.find((x) => x.id === 'book-named-client')!;
    const expensive: Model = {
      id: 'claude-opus-5-5',
      async next() {
        return {
          id: 'x',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'tool_use', id: 't', name: 'list_services', input: {} }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 100_000, output_tokens: 1_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    };
    const r = await runScenario(prisma, s, () => expensive, { costCapUsd: 0.5 });
    expect(r.stoppedBy).toBe('cost_cap');
    expect(r.turns).toBe(2); // $0.42 after one turn, $0.84 after two
    expect(r.pass).toBe(false);
  });

  it('prices from the table', () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage;
    expect(costUsd('claude-opus-5-5', usage)).toBeCloseTo(4 + 2, 6);
    expect(costUsd('claude-sonnet-5-5', usage)).toBeCloseTo(2 + 1, 6);
    expect(costUsd('unknown-model', usage)).toBeCloseTo(6, 6); // falls back to the Opus row
  });
});
