import { describe, it, expect } from 'vitest';
import { run } from '../../src/core/process.js';
import { CliError, TimeoutError } from '../../src/core/errors.js';

describe('run', () => {
  it('passes arguments as an array without shell interpretation', async () => {
    const stdout = await run('node', ['-e', 'console.log(process.argv[1])', 'hello; world']);
    expect(stdout.trim()).toBe('hello; world');
  });

  it('returns stdout on success', async () => {
    const stdout = await run('node', ['-e', 'console.log("ok")']);
    expect(stdout.trim()).toBe('ok');
  });

  it('throws CliError with stderr on non-zero exit', async () => {
    await expect(
      run('node', ['-e', 'console.error("boom"); process.exit(2)'])
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(CliError);
      const cli = err as CliError;
      expect(cli.exitCode).toBe(2);
      expect(cli.stderr).toContain('boom');
      expect(cli.code).toBe('cli');
      return true;
    });
  });

  it('throws TimeoutError when the command exceeds the deadline', async () => {
    await expect(
      run('node', ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 50 })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(TimeoutError);
      const timeout = err as TimeoutError;
      expect(timeout.deadlineMs).toBe(50);
      expect(timeout.command).toContain('node');
      expect(timeout.code).toBe('timeout');
      return true;
    });
  });

  it('writes input to stdin when provided', async () => {
    const stdout = await run('node', ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'hello from stdin',
    });
    expect(stdout).toBe('hello from stdin');
  });
});
