/**
 * The clock, injected — never read ambiently (CLAUDE.md: "The engine takes
 * `now` as a parameter. Nothing in packages/core reads the system clock").
 *
 * A function that reads the clock cannot be tested at a DST boundary without
 * waiting for March, and a test that reads the clock is wrong even when it
 * passes.
 */
import type { Instant } from './types';

export interface Clock {
  now(): Instant;
}

/** The only place in the repo permitted to read the wall clock. Composition
 *  roots (route handlers, jobs) take this; domain code takes an `Instant`. */
export const systemClock: Clock = {
  now: () => Date.now() as Instant,
};

/** Frozen clock for tests and for a request that must see one consistent
 *  `now` across several calls. */
export const fixedClock = (at: Instant): Clock => ({ now: () => at });
