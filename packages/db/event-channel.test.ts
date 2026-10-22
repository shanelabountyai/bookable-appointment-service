/**
 * M-009 — every writer of an AppointmentEvent records its channel.
 *
 * A new column with many writers is the status-enum trap (CLAUDE.md): one
 * forgotten site logs `desk` for an MCP write and nothing fails. This reads
 * the SOURCE of packages/db and requires every `actor: X.actor.type,` inside
 * an event write to be followed by `channel: channelOf(X.actor),`. It is the
 * same shape as the migration-vs-TypeScript status-list test: a fact held in
 * two places, compared mechanically.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Channel, apiActor, channelOf, customerTokenActor, mcpActor, staffActor, systemActor } from '../core/auth';

const ROOT = __dirname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'generated' || name === 'node_modules' || name === 'prisma') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('AppointmentEvent writers record the channel', () => {
  it('every event write\'s `actor: X.actor.type` is followed by `channel: channelOf(X.actor)`', () => {
    const missing: string[] = [];
    let sites = 0;
    for (const file of sourceFiles(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const m = /^\s*actor: (\w+)\.actor\.type,\s*$/.exec(line);
        if (!m) return;
        // Only AppointmentEvent writes: the create call (or book.ts's nested `events: {`) is within the
        // previous fourteen lines. Other tables stamp actor/actorRef too and have no channel column.
        const before = lines.slice(Math.max(0, i - 14), i).join('\n');
        if (!/appointmentEvent\.create(Many)?\(|events: \{/.test(before)) return;
        const block = lines.slice(i + 1, i + 3).join('\n');
        sites++;
        if (!block.includes(`channel: channelOf(${m[1]}.actor)`)) missing.push(`${relative(ROOT, file)}:${i + 1}`);
      });
    }
    expect(missing).toEqual([]);
    // The count is pinned so a NEW writer that spells the actor differently (and so escapes the regex) is noticed.
    expect(sites).toBe(13);
  });
});

describe('channelOf', () => {
  it('maps each actor to one channel, with mcp and api set explicitly', () => {
    expect(channelOf(staffActor('s1'))).toBe('desk');
    expect(channelOf(mcpActor('s1'))).toBe('mcp');
    expect(mcpActor('s1')).toEqual({ type: 'staff', ref: 's1', channel: 'mcp' });
    expect(channelOf(customerTokenActor('t1'))).toBe('manage_link');
    expect(channelOf(systemActor)).toBe('system');
    // W-001 / W-D1: an integration is the desk's rules with its own channel, and its ref is the KEY.
    expect(channelOf(apiActor('k1'))).toBe('api');
    expect(apiActor('k1')).toEqual({ type: 'staff', ref: 'k1', channel: 'api' });
  });

  it('the core Channel union and the database EventChannel enum hold the same values (W-001)', () => {
    // A new channel is never one edit: the migration, the Prisma enum and this
    // union must move together, and the compiler only sees one of the three.
    const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
    const block = /enum EventChannel \{([^}]*)\}/.exec(schema)![1]!;
    const values = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    const union: Record<Channel, true> = { desk: true, manage_link: true, mcp: true, system: true, api: true };
    expect(values.sort()).toEqual(Object.keys(union).sort());
  });
});
