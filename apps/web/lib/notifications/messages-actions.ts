'use server';

/**
 * A-051 — the desk's half of the retry policy.
 *
 * `requireStaff()` first, like every other staff action: this is the front
 * desk's screen, not the owner's. Fixing a wrong phone number and putting the
 * message back in the queue is reception work, and gating it behind the owner
 * role (A-050) would mean the one person who notices cannot act.
 */
import { prisma } from '@bookable/db';
import { retryNotification } from '@bookable/db/notifications';
import { requireStaff } from '@/lib/auth/session';

export interface RetryState {
  ok?: boolean;
  message?: string;
}

export async function retryMessage(_prev: RetryState, formData: FormData): Promise<RetryState> {
  const staff = await requireStaff();
  const id = String(formData.get('id') ?? '');

  // The business comes from the SESSION, never from the form — the same rule
  // the desk switch follows, and for the same reason.
  const queued = await retryNotification(prisma, { businessId: staff.businessId, id });
  if (!queued) {
    // Not an error worth a stack trace: the likeliest cause is two people on
    // two terminals looking at the same list, and the other one got there
    // first.
    return { ok: false, message: 'That one is not waiting to be sent any more — the list has moved on.' };
  }

  // NO `revalidatePath`, and that is the interesting line.
  //
  // A retried row stops being stuck the instant it succeeds — it is `pending`
  // with a fresh budget — so revalidating removes the row that is holding the
  // confirmation, and the desk sees it vanish with nothing said. (Found by the
  // e2e spec: the click worked, the list emptied, and the message was gone
  // with the component that owned it.) So the row keeps itself on screen and
  // says what happened, the same shape the booking panel uses after a booking.
  //
  // Nothing goes stale by leaving it: both this screen and the landing page's
  // count read cookies, so every visit re-renders them from the database.
  return { ok: true, message: 'Back in the queue. It goes out on the next run.' };
}
