/**
 * M-004 — one test per §6 code, asserting `error`, `field` and `next`.
 * These are the errors `packages/db` actually throws, constructed the way it
 * constructs them; nothing here goes near the database.
 */
import { describe, expect, it } from 'vitest';
import {
  AppointmentAlreadyMoved,
  AppointmentMovedFirst,
  RescheduleRefused,
  TransitionRefused,
} from '@bookable/db/appointments';
import { BookingRejected, NoResourceFree, SlotNotOffered, SlotTaken } from '@bookable/db/booking';
import { WaitlistEntryRejected } from '@bookable/db/waitlist';
import { ToolFailure, invalidArgument, mapDomainError, notFound, rateLimited, toolError } from './errors';

const ALT = [{ label: 'Thu 16 Oct, 3:00 pm', iso: '2026-10-16T15:00:00-05:00' }];

describe('mapDomainError', () => {
  it('SLOT_TAKEN — the constraint refused, with alternatives and a pointer to find_open_times', () => {
    const e = mapDomainError(new SlotTaken([]), { timeLabel: "Dana's 2:15 on Thu 16 Oct", alternatives: ALT });
    expect(e).toEqual({
      error: 'SLOT_TAKEN',
      message: "Dana's 2:15 on Thu 16 Oct was booked a moment ago.",
      field: 'start',
      next: { tool: 'find_open_times', why: 'pick another time' },
      alternatives: ALT,
    });
  });

  it('SLOT_TAKEN — not offered because somebody else is in the chair, buffer included', () => {
    const e = mapDomainError(new SlotNotOffered(['overlaps-buffer'], []));
    expect(e).toMatchObject({ error: 'SLOT_TAKEN', field: 'start', next: { tool: 'find_open_times' } });
    expect(e?.message).toMatch(/overlaps-buffer/);
  });

  it('SLOT_TAKEN — no chair free reads as taken, not as a configuration problem', () => {
    const e = mapDomainError(new NoResourceFree('Chair'));
    expect(e).toMatchObject({ error: 'SLOT_TAKEN', field: 'start', next: { tool: 'find_open_times' } });
  });

  it('OUTSIDE_HOURS — every reason is about the stylist not working, so the model should look at other hours', () => {
    const e = mapDomainError(new SlotNotOffered(['outside-working-window', 'overlaps-time-off'], []));
    expect(e).toMatchObject({ error: 'OUTSIDE_HOURS', field: 'start', next: { tool: 'find_open_times' } });
  });

  it('OUTSIDE_HOURS does not swallow a booking overlap: one taken reason makes it SLOT_TAKEN', () => {
    const e = mapDomainError(new SlotNotOffered(['outside-working-window', 'overlaps-booking'], []));
    expect(e?.error).toBe('SLOT_TAKEN');
  });

  it('AMBIGUOUS_TIME — the engine refused a DST-gap or suppressed-ambiguous candidate', () => {
    expect(mapDomainError(new SlotNotOffered(['nonexistent-local-time'], []))).toMatchObject({
      error: 'AMBIGUOUS_TIME',
      field: 'start',
    });
    expect(mapDomainError(new SlotNotOffered(['ambiguous-suppressed'], []))?.error).toBe('AMBIGUOUS_TIME');
    expect(mapDomainError(new SlotNotOffered(['nonexistent-local-time'], []))).not.toHaveProperty('next');
  });

  it('NOT_QUALIFIED — the stylist cannot do the whole visit (SVC-02), next is list_providers', () => {
    const booking = mapDomainError(new BookingRejected('serviceIds', 'Provider is not qualified for service x.'));
    expect(booking).toMatchObject({ error: 'NOT_QUALIFIED', field: 'provider_id', next: { tool: 'list_providers' } });
    const move = mapDomainError(new BookingRejected('toProviderId', 'They are not set up to do everything in this visit.'));
    expect(move).toMatchObject({ error: 'NOT_QUALIFIED', field: 'provider_id', next: { tool: 'list_providers' } });
  });

  it('INVALID_TRANSITION — from the transition table, next is get_appointment for allowed_actions', () => {
    const t = mapDomainError(new TransitionRefused('completed', 'checked_in', 'not-permitted'));
    expect(t).toMatchObject({ error: 'INVALID_TRANSITION', field: 'to', next: { tool: 'get_appointment' } });
    expect(t?.message).toMatch(/completed.*checked_in.*not-permitted/);
    const r = mapDomainError(new RescheduleRefused('in_progress', 'not-permitted'));
    expect(r).toMatchObject({ error: 'INVALID_TRANSITION', next: { tool: 'get_appointment' } });
  });

  it('NOT_FOUND — an unknown provider or client never hints that it exists elsewhere', () => {
    const p = mapDomainError(new BookingRejected('providerId', 'That provider is not on this book.'));
    expect(p).toMatchObject({ error: 'NOT_FOUND', field: 'provider_id', next: { tool: 'list_providers' } });
    const c = mapDomainError(new WaitlistEntryRejected('clientId', 'No such client.'));
    expect(c).toMatchObject({ error: 'NOT_FOUND', field: 'client_id', next: { tool: 'find_client' } });
    expect(JSON.stringify([p, c])).not.toMatch(/another|elsewhere|other business/i);
  });

  it('PROPOSAL_STALE — the row moved between preview and commit; next is the prepare tool that made it', () => {
    const e = mapDomainError(new AppointmentMovedFirst('booked', 'checked_in'), { retryTool: 'prepare_status_change' });
    expect(e).toMatchObject({ error: 'PROPOSAL_STALE', next: { tool: 'prepare_status_change' } });
    expect(mapDomainError(new AppointmentAlreadyMoved())?.error).toBe('PROPOSAL_STALE');
  });

  it('INVALID_ARGUMENT — a field-level rejection with no better code keeps its field', () => {
    expect(mapDomainError(new BookingRejected('startAt', 'A booking must start on a whole minute.'))).toEqual({
      error: 'INVALID_ARGUMENT',
      message: 'A booking must start on a whole minute.',
      field: 'startAt',
    });
    expect(mapDomainError(new WaitlistEntryRejected('toDay', 'That range ends before it starts.'))?.error).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('passes a ToolFailure envelope through unchanged, and returns null for anything else', () => {
    const f = notFound('appointment', 'appointment_id', 'get_day');
    expect(f).toBeInstanceOf(ToolFailure);
    expect(mapDomainError(f)).toBe(f.envelope);
    expect(mapDomainError(invalidArgument('day', 'nope'))).toMatchObject({ error: 'INVALID_ARGUMENT', field: 'day' });
    expect(mapDomainError(new Error('database on fire'))).toBeNull();
    expect(mapDomainError(new TypeError('x'))).toBeNull();
  });
});

describe('envelopes', () => {
  it('RATE_LIMITED carries retry_after_s and no next', () => {
    const r = rateLimited(60);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many calls for this token. Wait 60 seconds and try again.',
      retry_after_s: 60,
    });
  });

  it('toolError puts the same payload in content and structuredContent', () => {
    const r = toolError({ error: 'NOT_FOUND', message: 'm', field: 'f' });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(r.structuredContent);
  });
});
