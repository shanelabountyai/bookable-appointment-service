/**
 * Runs the scenarios (PRD §9.7). Manual, never CI: the real run spends API
 * credit. Prints one line per scenario and writes the full record to
 * eval/results/<timestamp>.json.
 *
 *   npm run eval:dry -w apps/mcp     # scripted model, no API calls — proves the harness and graders
 *   npm run eval -w apps/mcp         # Claude (EVAL_MODEL, default claude-opus-5-5), EVAL_COST_CAP_USD per scenario (default 1.00)
 *   EVAL_ONLY=book-named-client npm run eval -w apps/mcp
 *
 * Both use the TEST database (.env.test via the root scripts) and reset it per scenario.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@bookable/db';
import { runScenario, type ScenarioResult } from './harness';
import { ClaudeModel, ScriptedModel } from './model';
import { SCENARIOS } from './scenarios';

async function main(): Promise<void> {
  const dry = process.env.EVAL_DRY_RUN === '1';
  const only = process.env.EVAL_ONLY?.split(',').filter(Boolean);
  const costCapUsd = Number(process.env.EVAL_COST_CAP_USD ?? '1');
  if (process.env.NODE_ENV === 'production') throw new Error('The eval resets the database it points at. Never in production.');

  const prisma = new PrismaClient();
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.id))) {
      const result = await runScenario(
        prisma,
        scenario,
        (ids) => (dry ? new ScriptedModel(scenario.script, ids) : new ClaudeModel()),
        { costCapUsd, log: (line) => process.stderr.write(`${line}\n`) },
      );
      results.push(result);
      process.stdout.write(
        `${result.pass ? 'PASS' : 'FAIL'}  ${result.id.padEnd(28)} turns=${result.turns} tools=${result.toolCalls.length} $${result.costUsd.toFixed(4)} ${result.stoppedBy}  ${result.notes}\n`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.reduce((n, r) => n + r.costUsd, 0);
  process.stdout.write(`\n${passed}/${results.length} passed, $${total.toFixed(4)} total (${dry ? 'scripted model' : process.env.EVAL_MODEL ?? 'claude-opus-5-5'})\n`);

  mkdirSync('eval/results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`eval/results/${stamp}${dry ? '-dry' : ''}.json`, JSON.stringify({ model: dry ? 'scripted' : process.env.EVAL_MODEL ?? 'claude-opus-5-5', costCapUsd, results }, null, 2));
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`eval: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(2);
});
