import { execFile, type ChildProcess } from 'node:child_process';
import { CliError, TimeoutError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

export interface RunOptions {
  timeoutMs?: number;
  input?: string;
}

export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandLabel = `${cmd} ${args.join(' ')}`;

  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      maxBuffer: MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      if (error) {
        if (timedOut && error.killed) {
          reject(new TimeoutError(commandLabel, timeoutMs));
          return;
        }

        if (typeof error.code === 'number') {
          reject(new CliError(error.code, stderr, cmd));
          return;
        }

        reject(error);
        return;
      }

      resolve(stdout);
    });

    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        kill(child);
      }, timeoutMs);
    }

    if (opts.input !== undefined && child.stdin !== null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

function kill(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore: the process may have already exited.
  }
}
