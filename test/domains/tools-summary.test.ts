import { describe, expect, it } from 'vitest';
import { summarizePR } from '../../src/domains/code/tools.js';
import { summarizeIssue } from '../../src/domains/issues/tools.js';

describe('tool list summaries', () => {
  it('omits issue bodies', () => {
    expect(summarizeIssue({
      id: '42',
      title: 'Issue',
      body: 'large body',
      state: 'open',
      url: 'https://example.test/issues/42',
      labels: [],
      assignees: [],
    })).not.toHaveProperty('body');
  });

  it('omits pull request bodies', () => {
    expect(summarizePR({
      number: 7,
      title: 'PR',
      body: 'large body',
      state: 'open',
      url: 'https://example.test/pulls/7',
      headBranch: '7-change',
      baseBranch: 'main',
    })).not.toHaveProperty('body');
  });
});
