import { type ZodType } from 'zod';
import { run as runProcess, type RunOptions } from '../core/process.js';
import { CliError, ParseError } from '../core/errors.js';

export interface GhRunner {
  api<T>(
    path: string,
    schema: ZodType<T>,
    opts?: { method?: string; input?: unknown }
  ): Promise<T>;

  graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: ZodType<T>
  ): Promise<T>;

  /** Run an arbitrary `gh` subcommand and return the raw stdout. */
  raw(args: string[]): Promise<string>;
}

type RunFn = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;

export function createGhRunner(runFn: RunFn = runProcess): GhRunner {
  return {
    api: (path, schema, opts) => ghApi(path, schema, opts, runFn),
    graphql: (query, variables, schema) =>
      ghGraphql(query, variables, schema, runFn),
    raw: (args) => runFn('gh', args),
  };
}

async function ghApi<T>(
  path: string,
  schema: ZodType<T>,
  opts: { method?: string; input?: unknown } | undefined,
  runFn: RunFn
): Promise<T> {
  const args = ['api', path];
  let stdin: string | undefined;

  const method = opts?.method;
  const hasBody = opts?.input !== undefined;

  if (method !== undefined || hasBody) {
    args.push('--method', method ?? 'POST');
    args.push('--input', '-');
    stdin = JSON.stringify(opts?.input ?? {});
  }

  const stdout = await runFn('gh', args, { input: stdin });
  return parseJson(stdout, path, schema);
}

async function ghGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: ZodType<T>,
  runFn: RunFn
): Promise<T> {
  const args = ['api', 'graphql'];
  let stdin: string | undefined;

  if (hasNestedValue(variables)) {
    args.push('--input', '-');
    stdin = JSON.stringify({ query, variables });
  } else {
    args.push('-f', `query=${query}`);
    for (const [key, value] of Object.entries(variables)) {
      args.push('-F', `${key}=${formatScalar(value)}`);
    }
  }

  const stdout = await runFn('gh', args, { input: stdin });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new ParseError(
      'gh api graphql',
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const errors = extractGraphQLErrors(parsed);
  if (errors.length > 0) {
    throw new CliError(1, errors.join('; '), 'gh api graphql');
  }

  const data = (parsed as Record<string, unknown> | undefined)?.data;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ParseError('gh api graphql', result.error.message);
  }
  return result.data;
}

function hasNestedValue(variables: Record<string, unknown>): boolean {
  return Object.values(variables).some(
    (value) => value !== null && typeof value === 'object'
  );
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function extractGraphQLErrors(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const candidate = (parsed as Record<string, unknown>).errors;
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? String((entry as Record<string, unknown>).message ?? '')
        : String(entry)
    )
    .filter((message) => message.length > 0);
}

function parseJson<T>(stdout: string, source: string, schema: ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new ParseError(
      source,
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ParseError(source, result.error.message);
  }
  return result.data;
}
