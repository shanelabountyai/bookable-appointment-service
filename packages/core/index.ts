/** @bookable/core — the domain layer. No database, no framework, no I/O.
 *
 *  Prefer the subpath imports (`@bookable/core/time`, `/scheduling`, `/auth`,
 *  `/notifications`) over this barrel: they keep an import graph readable and
 *  stop a UI component pulling the slot engine in to use a date helper. */
export * from './auth';
export * from './notifications';
export * from './scheduling';
export * from './settings';
export * from './time';
