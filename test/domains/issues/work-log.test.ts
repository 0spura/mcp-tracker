import { describe, expect, it } from 'vitest';
import { formatWorkRecord, resolveWorkflowStage } from '../../../src/domains/issues/work-log.js';

describe('formatWorkRecord', () => {
  it('formats a compact, portable record without empty sections', () => {
    expect(
      formatWorkRecord({
        phase: 'implementation',
        summary: '  Removed duplicate status handling.  ',
        artifacts: ['src/domains/issues/tools.ts'],
        verification: ['npm test'],
        nextStep: 'Open the review.',
      })
    ).toBe(
      '## Work update: implementation\n\n' +
        'Removed duplicate status handling.\n\n' +
        '### Artifacts\n- src/domains/issues/tools.ts\n\n' +
        '### Verification\n- npm test\n\n' +
        '### Next step\nOpen the review.'
    );
  });
});

describe('resolveWorkflowStage', () => {
  it('maps a workflow key to the provider-facing stage name', () => {
    expect(
      resolveWorkflowStage(
        { workflow: { stages: [{ key: 'review', name: 'In Review' }] } },
        'review'
      )
    ).toBe('In Review');
  });

  it('fails closed for an unconfigured stage', () => {
    expect(() => resolveWorkflowStage({}, 'review')).toThrow('unknown workflow stage "review"');
  });
});
