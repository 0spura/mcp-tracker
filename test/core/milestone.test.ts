import { describe, it, expect } from 'vitest';
import { pickCurrentMilestone } from '../../src/core/milestone.js';

const now = new Date('2026-07-31T12:00:00Z');
const due = (milestone: { due: string | null }) => milestone.due;

describe('pickCurrentMilestone', () => {
  it('picks the milestone with the nearest upcoming due date', () => {
    const milestones = [
      { title: 'later', due: '2026-09-01' },
      { title: 'soon', due: '2026-08-15' },
    ];
    expect(pickCurrentMilestone(milestones, due, now)?.title).toBe('soon');
  });

  it('accepts a due date equal to today', () => {
    const milestones = [{ title: 'today', due: '2026-07-31' }];
    expect(pickCurrentMilestone(milestones, due, now)?.title).toBe('today');
  });

  it('skips past-due milestones', () => {
    const milestones = [
      { title: 'expired', due: '2026-07-17' },
      { title: 'soon', due: '2026-08-15' },
    ];
    expect(pickCurrentMilestone(milestones, due, now)?.title).toBe('soon');
  });

  it('skips undated milestones', () => {
    const milestones = [
      { title: 'undated', due: null },
      { title: 'soon', due: '2026-08-15' },
    ];
    expect(pickCurrentMilestone(milestones, due, now)?.title).toBe('soon');
  });

  it('accepts ISO datetimes and compares only the date part', () => {
    const milestones = [{ title: 'stamp', due: '2026-08-15T00:00:00.000Z' }];
    expect(pickCurrentMilestone(milestones, due, now)?.title).toBe('stamp');
  });

  it('returns undefined when no milestone qualifies', () => {
    const milestones = [
      { title: 'expired', due: '2026-07-17' },
      { title: 'undated', due: null },
    ];
    expect(pickCurrentMilestone(milestones, due, now)).toBeUndefined();
  });
});
