/**
 * THE PRECEDENCE CHAIN (AVAIL-01..04). Pure, and deliberately entirely on the
 * CALENDAR axis (D-3).
 *
 * Every window here is minutes-from-local-midnight — `09:00` is 540, and an
 * overnight close of `02:00` is 1560, not 120. No Instant, no ZoneId, no
 * Temporal: resolving these to actual instants is exactly one step, it belongs
 * to packages/core/time, and it happens later (A-026 feeds the result into
 * SlotQuery.windows). Doing the arithmetic in wall-clock minutes is what makes
 * this module DST-agnostic — "Dana works Tuesdays 9–5" is a rule about the
 * wall clock and stays true whatever the offset does that week.
 *
 * The chain, fixed (AVAIL-03):
 *   business override-or-weekly
 *     ∩ provider override-or-weekly      <- this module
 *     − breaks                            <- carried through as window children
 *     − time off / ad-hoc blocks          <- INSTANTS, subtracted by the engine
 *     − buffered bookings                 <- INSTANTS, subtracted by the engine
 *     − [−∞, now + leadTime)              <- subtracted by the engine
 *
 * Only the first two lines are wall-clock, so only they live here. Everything
 * below them is on the physical axis and is the engine's job — which is why
 * they are BusyIntervals and not windows.
 */

/** Minutes from local midnight. May exceed 1440 for an overnight close. */
export type DayMinute = number;

export interface MinuteBreak {
  openMin: DayMinute;
  closeMin: DayMinute;
}

export interface MinuteWindow {
  openMin: DayMinute;
  closeMin: DayMinute;
  breaks: MinuteBreak[];
}

export class InvalidAvailability extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidAvailability';
    this.field = field;
  }
}

/** "09:00" → 540. Accepts only HH:MM, the normalized WallTime shape (A-002). */
export function toDayMinute(wallTime: string): DayMinute {
  const match = /^(\d{2}):(\d{2})$/.exec(wallTime);
  if (!match) throw new InvalidAvailability('time', `Expected HH:MM, got: ${wallTime}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new InvalidAvailability('time', `Not a real time of day: ${wallTime}`);
  }
  return hours * 60 + minutes;
}

/** 540 → "09:00". 1560 (overnight) → "02:00", because the wall clock wraps. */
export function toWallTime(minute: DayMinute): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const hours = Math.floor(wrapped / 60);
  const minutes = wrapped % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export interface WindowInput {
  open: string;
  close: string;
  endsNextDay: boolean;
  breaks?: { open: string; close: string }[];
}

/**
 * Validates and converts one window.
 *
 * AVAIL-01: `close <= open` with `endsNextDay = false` is REFUSED, never
 * silently swapped and never silently empty. A provider who typed 17:00–09:00
 * by mistake must be told, because both plausible repairs — swapping the pair,
 * or treating it as overnight — invent hours she never agreed to work.
 */
export function toMinuteWindow(input: WindowInput): MinuteWindow {
  const openMin = toDayMinute(input.open);
  const rawClose = toDayMinute(input.close);
  const closeMin = input.endsNextDay ? rawClose + 1440 : rawClose;

  if (closeMin <= openMin) {
    throw new InvalidAvailability(
      'close',
      `A window closing at ${input.close} does not come after ${input.open}. ` +
        'Set "ends next day" if this is an overnight shift.',
    );
  }
  if (input.endsNextDay && rawClose >= openMin) {
    // 09:00 → 17:00 marked endsNextDay would be a 32-hour window. Almost
    // certainly a mis-tick, and cheaper to refuse than to explain later.
    throw new InvalidAvailability(
      'endsNextDay',
      `${input.open}–${input.close} already ends on the same day; "ends next day" would make it over 24 hours long.`,
    );
  }

  const breaks: MinuteBreak[] = [];
  for (const b of input.breaks ?? []) {
    // Lift each edge past midnight at most once, in the same order the wall
    // clock would reach it: a break that starts "before" the window open must
    // be on the far side of midnight, and a break that ends "before" its own
    // start must be too. Two independent single steps, rather than one
    // compound condition nobody can read at 3am.
    let bOpenMin = toDayMinute(b.open);
    if (bOpenMin < openMin) bOpenMin += 1440;
    let bCloseMin = toDayMinute(b.close);
    if (bCloseMin <= bOpenMin) bCloseMin += 1440;
    if (bOpenMin < openMin || bCloseMin > closeMin) {
      // AVAIL-01: a break belongs to the WINDOW, not the day. One that falls
      // outside its window is a data error, not a no-op — silently dropping it
      // is how a provider ends up bookable through her own lunch.
      throw new InvalidAvailability(
        'break',
        `Break ${b.open}–${b.close} falls outside its window ${input.open}–${input.close}.`,
      );
    }
    breaks.push({ openMin: bOpenMin, closeMin: bCloseMin });
  }

  breaks.sort((a, b) => a.openMin - b.openMin);
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i]!.openMin < breaks[i - 1]!.closeMin) {
      throw new InvalidAvailability('break', 'Two breaks in the same window overlap.');
    }
  }

  return { openMin, closeMin, breaks };
}

/** Merge touching/overlapping windows on the wall-clock axis. */
export function unionWindows(windows: readonly MinuteWindow[]): MinuteWindow[] {
  const sorted = [...windows].sort((a, b) => a.openMin - b.openMin || a.closeMin - b.closeMin);
  const merged: MinuteWindow[] = [];
  for (const w of sorted) {
    if (w.closeMin <= w.openMin) continue;
    const last = merged[merged.length - 1];
    if (last && w.openMin <= last.closeMin) {
      last.closeMin = Math.max(last.closeMin, w.closeMin);
      last.breaks = clipBreaks([...last.breaks, ...w.breaks], last.openMin, last.closeMin);
    } else {
      merged.push({ openMin: w.openMin, closeMin: w.closeMin, breaks: [...w.breaks] });
    }
  }
  return merged;
}

function clipBreaks(breaks: readonly MinuteBreak[], openMin: DayMinute, closeMin: DayMinute): MinuteBreak[] {
  const clipped: MinuteBreak[] = [];
  for (const b of breaks) {
    const start = Math.max(b.openMin, openMin);
    const end = Math.min(b.closeMin, closeMin);
    if (end > start) clipped.push({ openMin: start, closeMin: end });
  }
  clipped.sort((a, b) => a.openMin - b.openMin);
  // Merge breaks that now touch after clipping, so the engine never sees two
  // adjacent breaks where one continuous one is meant.
  const merged: MinuteBreak[] = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.openMin <= last.closeMin) last.closeMin = Math.max(last.closeMin, b.closeMin);
    else merged.push({ ...b });
  }
  return merged;
}

/**
 * business ∩ provider (AVAIL-04).
 *
 * Effective availability is the INTERSECTION, never the union: the salon being
 * open is a precondition for a stylist working, so a business holiday closes
 * everyone's day regardless of what their own weekly pattern says. Breaks from
 * BOTH sides survive into the result — a business-wide closed hour and a
 * provider's own lunch are both real, and the intersection of their open time
 * must exclude both.
 */
export function intersectWindows(
  business: readonly MinuteWindow[],
  provider: readonly MinuteWindow[],
): MinuteWindow[] {
  const result: MinuteWindow[] = [];
  for (const b of business) {
    for (const p of provider) {
      const openMin = Math.max(b.openMin, p.openMin);
      const closeMin = Math.min(b.closeMin, p.closeMin);
      if (closeMin <= openMin) continue;
      result.push({
        openMin,
        closeMin,
        breaks: clipBreaks([...b.breaks, ...p.breaks], openMin, closeMin),
      });
    }
  }
  return unionWindows(result);
}

export interface DayPattern {
  /** Weekly windows for this weekday. Ignored when `override` is present. */
  weekly: readonly MinuteWindow[];
  /**
   * The date-specific override, when one exists for this day (AVAIL-02).
   *
   * `null` means NO override — distinct from an override with `isClosed: true`
   * and no windows, which means "explicitly closed that day". The schema makes
   * that distinction representable and this type preserves it; collapsing the
   * two is how a holiday silently becomes an ordinary working day.
   */
  override: { isClosed: boolean; windows: readonly MinuteWindow[] } | null;
}

/** An override REPLACES the weekly pattern entirely — it never merges with it
 *  (AVAIL-02). "Open 10–2 on Christmas Eve" means exactly 10–2, not 10–2 plus
 *  the usual 9–5. */
export function effectiveWindows(pattern: DayPattern): MinuteWindow[] {
  if (pattern.override) {
    return pattern.override.isClosed ? [] : unionWindows(pattern.override.windows);
  }
  return unionWindows(pattern.weekly);
}

/**
 * The whole wall-clock half of the chain, in one call: business
 * override-or-weekly ∩ provider override-or-weekly.
 *
 * Returns [] when either side is closed, which is AVAIL-04's acceptance
 * criterion ("a business-level holiday closes every provider's day").
 */
export function resolveAvailableWindows(business: DayPattern, provider: DayPattern): MinuteWindow[] {
  const businessWindows = effectiveWindows(business);
  if (businessWindows.length === 0) return [];
  const providerWindows = effectiveWindows(provider);
  if (providerWindows.length === 0) return [];
  return intersectWindows(businessWindows, providerWindows);
}

/** Back to the wall-clock shape the slot engine's SlotQuery expects. The
 *  caller (A-026) brands these as WallTime and resolves them to instants. */
export function toWindowInput(window: MinuteWindow): Required<WindowInput> {
  return {
    open: toWallTime(window.openMin),
    close: toWallTime(window.closeMin),
    endsNextDay: window.closeMin >= 1440,
    breaks: window.breaks.map((b) => ({ open: toWallTime(b.openMin), close: toWallTime(b.closeMin) })),
  };
}
