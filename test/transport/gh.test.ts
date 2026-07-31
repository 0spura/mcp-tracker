import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGhRunner } from '../../src/transport/gh.js';
import { createFakeGh } from '../helpers/fake-gh.js';
import { CliError, ParseError } from '../../src/core/errors.js';

describe('GhRunner', () => {
  describe('api', () => {
    it('calls gh api with the path as an argument array', async () => {
      const fake = createFakeGh([
        { stdout: JSON.stringify({ id: 1, title: 'hello' }) },
      ]);
      const runner = createGhRunner(fake.run);
      const schema = z.object({ id: z.number(), title: z.string() });

      const result = await runner.api('/repos/owner/repo/issues/1', schema);

      expect(result).toEqual({ id: 1, title: 'hello' });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toEqual({
        cmd: 'gh',
        args: ['api', '/repos/owner/repo/issues/1'],
        input: undefined,
      });
    });

    it('passes method and body via --input on stdin', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ id: 2 }) }]);
      const runner = createGhRunner(fake.run);
      const schema = z.object({ id: z.number() });

      const result = await runner.api('/repos/owner/repo/issues', schema, {
        method: 'POST',
        input: { title: 'x' },
      });

      expect(result).toEqual({ id: 2 });
      expect(fake.calls[0].cmd).toBe('gh');
      expect(fake.calls[0].args).toEqual([
        'api',
        '/repos/owner/repo/issues',
        '--method',
        'POST',
        '--input',
        '-',
      ]);
      expect(fake.calls[0].input).toBe(JSON.stringify({ title: 'x' }));
    });

    it('defaults to POST when input is given without a method', async () => {
      const fake = createFakeGh([{ stdout: '{}' }]);
      const runner = createGhRunner(fake.run);

      await runner.api('/test', z.object({}), { input: { a: 1 } });

      const methodIndex = fake.calls[0].args.indexOf('--method');
      expect(methodIndex).toBeGreaterThan(-1);
      expect(fake.calls[0].args[methodIndex + 1]).toBe('POST');
      expect(fake.calls[0].input).toBe(JSON.stringify({ a: 1 }));
    });

    it('throws ParseError naming the endpoint on zod mismatch', async () => {
      const fake = createFakeGh([
        { stdout: JSON.stringify({ id: 'not-a-number' }) },
      ]);
      const runner = createGhRunner(fake.run);
      const schema = z.object({ id: z.number() });

      await expect(
        runner.api('/repos/owner/repo/issues/1', schema)
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ParseError);
        const parse = err as ParseError;
        expect(parse.source).toBe('/repos/owner/repo/issues/1');
        expect(parse.code).toBe('parse');
        return true;
      });
    });

    it('propagates CliError on non-zero gh exit', async () => {
      const error = new CliError(1, 'not found', 'gh');
      const fake = createFakeGh([{ error }]);
      const runner = createGhRunner(fake.run);

      await expect(runner.api('/x', z.object({}))).rejects.toBe(error);
    });
  });

  describe('graphql', () => {
    it('sends scalar variables as -F flags and query as -f flag', async () => {
      const fake = createFakeGh([
        { stdout: JSON.stringify({ data: { node: { id: 'I_1' } } }) },
      ]);
      const runner = createGhRunner(fake.run);
      const schema = z.object({ node: z.object({ id: z.string() }) });
      const query =
        'query GetIssue($owner:String!, $repo:String!, $number:Int!) { node }';

      const result = await runner.graphql(
        query,
        { owner: 'acme', repo: 'widget', number: 42 },
        schema
      );

      expect(result).toEqual({ node: { id: 'I_1' } });
      const args = fake.calls[0].args;
      expect(args).toContain('-f');
      expect(args[args.indexOf('-f') + 1]).toBe(`query=${query}`);
      expect(args).toContain('owner=acme');
      expect(args).toContain('repo=widget');
      expect(args).toContain('number=42');
    });

    it('sends null, boolean, and number scalars as -F flags', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGhRunner(fake.run);

      await runner.graphql(
        'q',
        { a: null, b: true, c: false, d: 0 },
        z.object({})
      );

      const args = fake.calls[0].args;
      expect(args).toContain('a=');
      expect(args).toContain('b=true');
      expect(args).toContain('c=false');
      expect(args).toContain('d=0');
    });

    it('switches to --input when any variable is a nested object', async () => {
      const fake = createFakeGh([
        {
          stdout: JSON.stringify({
            data: { updateIssue: { issue: { id: 'I_1' } } },
          }),
        },
      ]);
      const runner = createGhRunner(fake.run);
      const schema = z.object({
        updateIssue: z.object({ issue: z.object({ id: z.string() }) }),
      });
      const query =
        'mutation($input: UpdateIssueInput!) { updateIssue(input: $input) { issue { id } } }';
      const variables = { input: { id: 'I_1', title: 'new title' } };

      const result = await runner.graphql(query, variables, schema);

      expect(result).toEqual({ updateIssue: { issue: { id: 'I_1' } } });
      expect(fake.calls[0].args).toEqual([
        'api',
        'graphql',
        '--input',
        '-',
      ]);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        query,
        variables,
      });
    });

    it('switches to --input when any variable is an array', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGhRunner(fake.run);

      await runner.graphql('q', { items: [1, 2] }, z.object({}));

      expect(fake.calls[0].args).toEqual(['api', 'graphql', '--input', '-']);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        query: 'q',
        variables: { items: [1, 2] },
      });
    });

    it('throws CliError with GraphQL error messages from a 200 response', async () => {
      const fake = createFakeGh([
        {
          stdout: JSON.stringify({
            errors: [{ message: 'boom' }, { message: 'bad input' }],
          }),
        },
      ]);
      const runner = createGhRunner(fake.run);

      await expect(
        runner.graphql('q', {}, z.object({}))
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(CliError);
        const cli = err as CliError;
        expect(cli.exitCode).toBe(1);
        expect(cli.stderr).toContain('boom');
        expect(cli.stderr).toContain('bad input');
        expect(cli.code).toBe('cli');
        return true;
      });
    });

    it('never interpolates scalar variable values into the query string', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGhRunner(fake.run);
      const query = 'query($n:Int!) { issue(number: $n) { title } }';

      await runner.graphql(query, { n: 42 }, z.object({}));

      const args = fake.calls[0].args;
      const queryArg = args[args.indexOf('-f') + 1];
      expect(queryArg).toBe(`query=${query}`);
      expect(queryArg).not.toContain('42');
    });
  });

  describe('hostile input', () => {
    const hostile = '$(rm -rf ~)"\n\'hello';

    it('sends hostile REST body as stdin JSON, not in argument array', async () => {
      const fake = createFakeGh([{ stdout: '{}' }]);
      const runner = createGhRunner(fake.run);

      await runner.api('/test', z.object({}), {
        method: 'POST',
        input: { title: hostile },
      });

      const call = fake.calls[0];
      expect(call.args).toEqual([
        'api',
        '/test',
        '--method',
        'POST',
        '--input',
        '-',
      ]);
      expect(call.input).toBe(JSON.stringify({ title: hostile }));
      expect(call.args.some((arg) => arg.includes(hostile))).toBe(false);
    });

    it('sends hostile GraphQL scalar as -F data, never into the query', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGhRunner(fake.run);
      const query = 'query($x:String!) { x }';

      await runner.graphql(query, { x: hostile }, z.object({}));

      const args = fake.calls[0].args;
      expect(args).toContain(`x=${hostile}`);
      const queryArg = args[args.indexOf('-f') + 1];
      expect(queryArg).toBe(`query=${query}`);
      expect(queryArg).not.toContain(hostile);
    });

    it('sends hostile GraphQL nested value inside JSON stdin body', async () => {
      const fake = createFakeGh([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGhRunner(fake.run);
      const query = 'mutation($input: X!) { x }';
      const variables = { input: { title: hostile } };

      await runner.graphql(query, variables, z.object({}));

      expect(fake.calls[0].args).toEqual(['api', 'graphql', '--input', '-']);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        query,
        variables,
      });
    });
  });
});
