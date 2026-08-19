/**
 * A-022 — THE REMINDER JOB'S TRIGGER (NOTIF-02).
 *
 * The first HTTP route handler in this app — everything else is a server
 * action, because nothing else needs to be called by something outside a
 * browser. An external scheduler (Vercel Cron, see `vercel.json`) is exactly
 * that: this is the one seam where "outside" reaches in.
 *
 * Decide-and-enqueue (`sendDueReminders`) and send (`dispatchPendingNotifications`)
 * run back to back here rather than only the first: nothing else in the repo
 * calls dispatch on a schedule (dispatch.ts's own comment names this route as
 * the reason), so without this every outbox row — reminders and everything
 * enqueued before them — would sit `pending` forever.
 *
 * `vercel.json` schedules this every 5 minutes, matching the window's own
 * width so no tick leaves a gap. A Hobby-plan deployment is limited to daily
 * cron and would need an external scheduler hitting this route with the
 * bearer token instead — a deployment-tier question, not a correctness one.
 */
import { NextResponse } from 'next/server';
import { prisma } from '@bookable/db';
import { dispatchPendingNotifications, notificationAdapter, sendDueReminders } from '@bookable/db/notifications';

export const dynamic = 'force-dynamic';

function cronSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Loud, not a fallback — same reasoning as SESSION_SECRET (session.ts). A
    // default here means anyone who finds the URL can trigger a reissue of
    // every live manage token in the database.
    throw new Error('CRON_SECRET is not set — refusing to run the reminder job.');
  }
  return secret;
}

export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${cronSecret()}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const reminders = await sendDueReminders(prisma, new Date());
  const dispatch = await dispatchPendingNotifications(prisma, notificationAdapter);

  return NextResponse.json({ reminders, dispatch });
}
