import { type ZodType } from 'zod';
import { run as runProcess, type RunOptions } from '../core/process.js';
import { CliError, ParseError } from '../core/errors.js';

export interface GlabRunner {
  api<T>(
    path: string,
    schema: ZodType<T>,
    opts?: { method?: string; fields?: Record<string, unknown> }
  ): Promise<T>;

  graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    schema: ZodType<T>
  ): Promise<T>;

  /** Run an arbitrary `glab` subcommand and return the raw stdout. */
  raw(args: string[]): Promise<string>;
}

type RunFn = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;

export function createGlabRunner(runFn: RunFn = runProcess): GlabRunner {
  return {
    api: (path, schema, opts) => glabApi(path, schema, opts, runFn),
    graphql: (query, variables, schema) =>
      glabGraphql(query, variables, schema, runFn),
    raw: (args) => runFn('glab', args),
  };
}

async function glabApi<T>(
  path: string,
  schema: ZodType<T>,
  opts: { method?: string; fields?: Record<string, unknown> } | undefined,
  runFn: RunFn
): Promise<T> {
  const args = ['api', path];

  const method = opts?.method;
  const fields = opts?.fields;
  const hasBody = fields !== undefined && Object.keys(fields).length > 0;
  let stdin: string | undefined;

  if (method !== undefined || hasBody) {
    args.push('--method', method ?? 'POST');
  }

  if (fields !== undefined) {
    args.push('--input', '-', '-H', 'Content-Type: application/json');
    stdin = JSON.stringify(fields);
  }

  const stdout = await runFn('glab', args, { input: stdin });
  return parseJson(stdout, path, schema);
}

async function glabGraphql<T>(
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

  const stdout = await runFn('glab', args, { input: stdin });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new ParseError(
      'glab api graphql',
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const errors = extractGraphQLErrors(parsed);
  if (errors.length > 0) {
    throw new CliError(1, errors.join('; '), 'glab api graphql');
  }

  const data = (parsed as Record<string, unknown> | undefined)?.data;
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ParseError('glab api graphql', result.error.message);
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
