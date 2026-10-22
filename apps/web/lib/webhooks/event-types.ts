/** W-011 — the published event types (API PRD §8), in the owner's words. None ticked = all of them. */
export const EVENT_TYPES = [
  { value: 'appointment.booked', label: 'Booked' },
  { value: 'appointment.rescheduled', label: 'Moved' },
  { value: 'appointment.reassigned', label: 'Stylist changed' },
  { value: 'appointment.cancelled', label: 'Cancelled' },
  { value: 'appointment.status_changed', label: 'Checked in / finished / no-show' },
  { value: 'appointment.status_corrected', label: 'Status corrected' },
] as const;
