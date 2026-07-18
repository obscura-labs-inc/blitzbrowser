/**
 * Idle-based staleness check for the browser pool reaper.
 *
 * A stale instance is one that has had NO CDP activity (in either direction)
 * for longer than `max_age_seconds`. An instance being actively driven over its
 * CDP session generates a steady stream of traffic and is therefore never
 * stale, so the reaper cannot tear down a browser mid-submission. Only genuinely
 * idle instances — a leaked/half-open connection whose client is gone — go quiet
 * and become reapable.
 */
export interface StaleCheckStatus {
  connected_at?: string | null;
  last_activity_at?: string | null;
}

/**
 * Seconds since the instance last saw CDP activity. Falls back to the connect
 * time before any traffic has flowed. Returns null for an instance that has not
 * connected a tunnel yet (brand new, never reapable).
 */
export function idleSeconds(status: StaleCheckStatus, now_ms: number): number | null {
  const reference = status.last_activity_at ?? status.connected_at;
  if (!reference) return null;

  return (now_ms - new Date(reference).getTime()) / 1000;
}

export function isIdleStale(status: StaleCheckStatus, now_ms: number, max_age_seconds: number): boolean {
  const idle = idleSeconds(status, now_ms);
  if (idle === null) return false;

  return idle > max_age_seconds;
}
