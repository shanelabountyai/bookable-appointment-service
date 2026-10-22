/**
 * W-009 — the webhook SWEEP on its own (API PRD §8 "Dispatch" 2). NOT
 * scheduled: per W-D23 the sweep rides the daily reminders cron. This route
 * exists so a local demo can trigger a sweep with the cron bearer, and so
 * restoring an hourly cadence is one `vercel.json` line
 * (`{ "path": "/api/jobs/webhooks", "schedule": "0 * * * *" }`).
 *
 * Same bearer as the reminder job, compared in constant time (SEC-05).
 */
import { NextResponse } from 'next/server';
import { prisma } from '@bookable/db';
import { constantTimeEqual } from '@bookable/core/auth';
import { pruneIdempotencyRecords } from '@bookable/db/api';
import { sweepWebhooks } from '@/lib/api/webhooks';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET is not set — refusing to run the webhook sweep.');
  if (!constantTimeEqual(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = () => new Date();
  const webhooks = await sweepWebhooks({ prisma, now });
  const prunedIdempotency = await pruneIdempotencyRecords(prisma, now());
  return NextResponse.json({ webhooks, prunedIdempotency });
}
