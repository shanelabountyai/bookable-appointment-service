export {
  type ClientSummary,
  type ClientVisit,
  MergeRefused,
  type MergeResult,
  type RebookSuggestion,
  clientHistory,
  findClient,
  findClientsByPhone,
  mergeClients,
  rebookSuggestion,
  searchClients,
  setClientNotes,
} from './clients';
export {
  type ClientReliability,
  type MissedAppointment,
  clientReliability,
  missedAppointments,
  reliabilityFor,
} from './reliability';
export {
  type CallMark,
  type CallMarkOutcome,
  clearCallMark,
  listCallMarks,
  recordCallMark,
} from './call-marks';
