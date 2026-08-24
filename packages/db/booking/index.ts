export { type BookAppointmentInput, type BookedAppointment, bookAppointment, newIdempotencyKey } from './book';
export { BookingRejected, SelfServeBlocked, SlotNotOffered, SlotTaken } from './errors';
export { type WalkInOption, clientAlreadyBookedAround, walkInOptions } from './walk-in';
export { NoResourceFree } from './errors';
export { chairForMove, findFreeResource, requiredResourceTypeId } from './resources';
export {
  type CreateSeriesInput,
  type CreateSeriesResult,
  type SeriesOccurrenceResult,
  type SkipReason,
  createSeries,
  listSeriesOccurrences,
} from './series';
