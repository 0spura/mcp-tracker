import type { RunOptions } from '../../src/core/process.js';

export interface CapturedCall {
  cmd: string;
  args: string[];
  input?: string;
}

export type FakeResponse = { stdout: string } | { error: Error };

export function createFakeGlab(responses: FakeResponse[] = []): {
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let index = 0;

  return {
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, input: opts?.input });
      if (index >= responses.length) {
        throw new Error(
          `Unexpected glab call #${index}: ${cmd} ${args.join(' ')}`
        );
      }
      const response = responses[index++];
      if ('error' in response) throw response.error;
      return response.stdout;
    },
    calls,
  };
}
