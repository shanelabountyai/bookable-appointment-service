/**
 * A-022 — the reminder window, pure (NOTIF-02, spec X-3/X-4).
 *
 * The spring-forward instant here is taken verbatim from
 * docs/reviews/03-slot-engine-spec.md §3 row X-3, not re-derived (CLAUDE.md).
 */
import { describe, expect, it } from 'vitest';
import { instantFromIso, toLabel, wallTime, zoneId } from '../time';
import { REMINDER_LEAD_MS, REMINDER_WINDOW_MS, reminderWindow } from './reminder';

const CHI = zoneId('America/Chicago');

describe('reminderWindow() (X-3, X-4)', () => {
  it('is a physical 24 hours, not a calendar day — spring-forward crosses the gap', () => {
    // The JOB fires at now = 2026-03-07T14:00Z, and catches the appointment
    // AT 2026-03-08T14:00Z — the spec's own ground truth for 09:00 CDT
    // (spring-forward already happened at 02:00 local that day).
    const now = instantFromIso('2026-03-07T14:00:00Z');
    const window = reminderWindow(now);

    expect(window.start).toBe(instantFromIso('2026-03-08T14:00:00Z'));
    expect(window.end).toBe(instantFromIso('2026-03-08T14:05:00Z'));

    // The artifact X-3 asks to make visible: read back in the salon's zone,
    // the JOB itself is firing at 08:00 the day before — not 09:00. Physical
    // 24 hours across a skipped hour lands an hour short of a full local day.
    const firingLabel = toLabel(now, CHI);
    expect(firingLabel.day).toBe('2026-03-07');
    expect(firingLabel.time).toBe(wallTime('08:00'));

    const appointmentLabel = toLabel(window.start, CHI);
    expect(appointmentLabel.day).toBe('2026-03-08');
    expect(appointmentLabel.time).toBe(wallTime('09:00'));
  });

  it('is 5 minutes wide, half-open', () => {
    const now = instantFromIso('2026-06-08T08:00:00-05:00');
    const window = reminderWindow(now);

    expect(window.end - window.start).toBe(REMINDER_WINDOW_MS);
    expect(window.start - now).toBe(REMINDER_LEAD_MS);
  });
});
