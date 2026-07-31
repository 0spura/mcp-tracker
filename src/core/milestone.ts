/**
 * Sentinel milestone title meaning "the current milestone": the active
 * milestone with the nearest upcoming due date. Providers resolve it when a
 * milestone title is accepted (config defaults, session context, tool args).
 */
export const CURRENT_MILESTONE = '$current';

/**
 * Pick the milestone with the nearest due date that has not passed. Undated
 * and past-due milestones are skipped. Returns undefined when none qualifies.
 */
export function pickCurrentMilestone<T>(
  milestones: T[],
  dueDate: (milestone: T) => string | null | undefined,
  now: Date = new Date()
): T | undefined {
  const today = now.toISOString().slice(0, 10);
  const upcoming = milestones.filter((milestone) => {
    const due = dueDate(milestone);
    return due != null && due.slice(0, 10) >= today;
  });
  upcoming.sort((a, b) =>
    dueDate(a)!.slice(0, 10).localeCompare(dueDate(b)!.slice(0, 10))
  );
  return upcoming[0];
}

