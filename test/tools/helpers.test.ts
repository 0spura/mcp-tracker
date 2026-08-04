import { describe, it, expect } from 'vitest';
import { appendAttachments, ISSUE_NUMBER_PARAM } from '../../src/tools/helpers.js';
import { UnsupportedError } from '../../src/core/errors.js';
import type { IssueProvider } from '../../src/domains/issues/capabilities.js';

const repo = { owner: 'acme', repo: 'widget' };

function makeProvider(attachFile: IssueProvider['attachFile']): IssueProvider {
  return {
    listIssues: async () => [],
    createIssue: async () => {
      throw new Error('not used');
    },
    getIssue: async () => {
      throw new Error('not used');
    },
    updateIssue: async () => {
      throw new Error('not used');
    },
    setIssueStatus: async () => {},
    addIssueComment: async () => {},
    listIssueComments: async () => [],
    attachFile,
  };
}

describe('appendAttachments', () => {
  it('returns the body unchanged when no attachments are given', async () => {
    const provider = makeProvider(undefined);
    const result = await appendAttachments(provider, { repo }, 'hello', undefined);
    expect(result).toEqual({ body: 'hello', warnings: [] });
  });

  it('throws UnsupportedError when attachments are given but the provider has no attachFile', async () => {
    const provider = makeProvider(undefined);
    await expect(
      appendAttachments(provider, { repo }, 'hello', ['/tmp/a.png'])
    ).rejects.toBeInstanceOf(UnsupportedError);
  });

  it('appends uploaded markdown links to the body', async () => {
    const provider = makeProvider(async (_scope, filePath) => ({
      url: `/uploads/${filePath}`,
      markdown: `[${filePath}](/uploads/${filePath})`,
    }));

    const result = await appendAttachments(provider, { repo }, 'hello', ['a.png', 'b.png']);

    expect(result.warnings).toEqual([]);
    expect(result.body).toBe('hello\n\n[a.png](/uploads/a.png)\n[b.png](/uploads/b.png)');
  });

  it('collects per-file failures as warnings without throwing', async () => {
    const provider = makeProvider(async (_scope, filePath) => {
      if (filePath === 'bad.png') throw new Error('upload failed');
      return { url: `/uploads/${filePath}`, markdown: `[${filePath}](/uploads/${filePath})` };
    });

    const result = await appendAttachments(provider, { repo }, 'hello', ['good.png', 'bad.png']);

    expect(result.body).toBe('hello\n\n[good.png](/uploads/good.png)');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('upload "bad.png" failed');
  });

  it('builds the body from just the links when the original body is empty', async () => {
    const provider = makeProvider(async (_scope, filePath) => ({
      url: `/uploads/${filePath}`,
      markdown: `[${filePath}](/uploads/${filePath})`,
    }));

    const result = await appendAttachments(provider, { repo }, '', ['a.png']);

    expect(result.body).toBe('[a.png](/uploads/a.png)');
  });
});

describe('ISSUE_NUMBER_PARAM', () => {
  it('requires a positive issue number', () => {
    expect(ISSUE_NUMBER_PARAM.safeParse(undefined).success).toBe(false);
    expect(ISSUE_NUMBER_PARAM.safeParse(0).success).toBe(false);
    expect(ISSUE_NUMBER_PARAM.safeParse(42).success).toBe(true);
  });
});
