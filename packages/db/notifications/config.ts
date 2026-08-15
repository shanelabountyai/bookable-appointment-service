/**
 * The two safety controls a notification engine is negligent without (D-14).
 *
 * KILL SWITCH. Something will eventually go wrong in a way that sends the
 * same message to every client on the book — a botched migration, a job that
 * loops, a reminder query with a wrong date range. The only useful response
 * is a switch that stops sending in under a minute without a deploy, and
 * every send path has to read it. `NOTIFICATIONS_ENABLED=false` does that;
 * notifications are still DECIDED and RECORDED as suppressed (in enqueue()),
 * so afterwards there is a complete list of exactly what would have gone out.
 * dispatch() also re-checks it before sending anything already queued, so
 * flipping the switch mid-backlog halts sends immediately, not just future
 * enqueues.
 *
 * SANDBOX REDIRECT. The one that prevents the incident nobody recovers from:
 * texting a real client from a developer's laptop pointed at a copy of
 * production data. `NOTIFICATIONS_SANDBOX_TO` redirects every send to one
 * address while the outbox row still records the address it WOULD have used
 * — so a staging environment can exercise the whole path against real-looking
 * recipients and reach nobody.
 *
 * Both are environment variables, not database rows: a kill switch that needs
 * a working database to read is a kill switch that doesn't work during the
 * incident where the database is the problem.
 */

export interface NotificationConfig {
  /** False suppresses every send. Notifications are still recorded, with
   *  lastError `suppressed:kill_switch`. */
  enabled: boolean;
  /** When set, every actual send is redirected here regardless of recipient.
   *  The intended address stays on the outbox row's `recipient` column. */
  sandboxTo: string | null;
}

/**
 * Read per call rather than captured at module load, so flipping the switch
 * takes effect on the next call rather than the next process restart.
 *
 * Defaults to ENABLED. A missing variable meaning "off" would be a silent,
 * business-wide outage on any deploy that forgot to set it — a confirmation
 * that quietly never arrives is the exact failure this whole seam exists to
 * make impossible, and the default must not be it. The sandbox redirect is
 * the control that makes an enabled-by-default engine safe in a
 * non-production environment, which is why the two are read together.
 */
export function notificationConfig(): NotificationConfig {
  const sandboxTo = process.env.NOTIFICATIONS_SANDBOX_TO?.trim();
  return {
    enabled: process.env.NOTIFICATIONS_ENABLED !== 'false',
    sandboxTo: sandboxTo ? sandboxTo : null,
  };
}
