/**
 * Which adapter this build actually sends through.
 *
 * The one place a real driver gets wired in later (D-14: "a later
 * one-assignment swap"). Everything else in this module — enqueue, dispatch,
 * the kill switch, the sandbox redirect — is already exercised against
 * whatever is assigned here.
 */
import { LoggingChannelAdapter } from '../../core/notifications';
import type { ChannelAdapter } from '../../core/notifications';

export const notificationAdapter: ChannelAdapter = new LoggingChannelAdapter();
