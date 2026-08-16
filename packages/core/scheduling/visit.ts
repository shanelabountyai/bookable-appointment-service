/**
 * MULTI-SERVICE VISITS (VISIT-01, D-23). Pure.
 *
 * One appointment, one provider, several ordered services — "cut then colour",
 * which is half the sample salon's Saturday.
 *
 * THE COMPOSITION RULE, and why it is not simply "add everything up":
 *
 *   duration     = the SUM of every line's duration
 *   bufferBefore = the FIRST line's bufferBefore
 *   bufferAfter  = the LAST line's bufferAfter
 *
 * Buffers do NOT stack between lines. A buffer exists to protect the gap
 * between two *clients* — tidying the chair, washing the bowl, the stylist
 * drawing breath. Inside one visit the client never leaves, so the colour's
 * "15 minutes before" is time the stylist is already standing there with her.
 * Stacking them would silently inflate a cut+colour by half an hour of dead
 * time nobody scheduled, and the salon would wonder why its book stopped
 * fitting.
 *
 * The consequence is that the slot engine needs NO change: a composed visit is
 * simply a longer service with one buffer at each end (D-23).
 */

export class InvalidVisit extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVisit';
  }
}

export interface VisitLine {
  serviceId: string;
  /** Already resolved per provider (SVC-02) — a junior stylist's longer cut
   *  composes at HER duration, not the catalogue's. */
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceCents: number;
}

export interface ComposedVisit {
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** What the visit costs, for the confirmation and for RPT-01. Each LINE
   *  still snapshots its own price (D-18) — this is the sum, not a
   *  replacement for the per-line record. */
  totalPriceCents: number;
}

export function composeVisit(lines: readonly VisitLine[]): ComposedVisit {
  if (lines.length === 0) {
    throw new InvalidVisit('A visit needs at least one service.');
  }
  for (const line of lines) {
    if (!Number.isInteger(line.durationMinutes) || line.durationMinutes <= 0) {
      throw new InvalidVisit(`Service ${line.serviceId} has a non-positive duration.`);
    }
  }

  const first = lines[0]!;
  const last = lines[lines.length - 1]!;

  return {
    durationMinutes: lines.reduce((total, line) => total + line.durationMinutes, 0),
    // NOT summed, and not the max: the visit is bounded by the gap before the
    // client arrives and the gap after she leaves. Everything between is her
    // own appointment.
    bufferBeforeMinutes: first.bufferBeforeMinutes,
    bufferAfterMinutes: last.bufferAfterMinutes,
    totalPriceCents: lines.reduce((total, line) => total + line.priceCents, 0),
  };
}

/** True when this is the ordinary one-service case, so callers can keep the
 *  simple path readable rather than special-casing length everywhere. */
export const isSingleService = (lines: readonly VisitLine[]): boolean => lines.length === 1;
