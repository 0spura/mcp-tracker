import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createGlabRunner } from '../../src/transport/glab.js';
import { createFakeGlab } from '../helpers/fake-glab.js';
import { CliError, ParseError } from '../../src/core/errors.js';

describe('GlabRunner', () => {
  describe('api', () => {
    it('calls glab api with the path as an argument array', async () => {
      const fake = createFakeGlab([
        { stdout: JSON.stringify({ id: 1, title: 'hello' }) },
      ]);
      const runner = createGlabRunner(fake.run);
      const schema = z.object({ id: z.number(), title: z.string() });

      const result = await runner.api('projects/acme%2Fwidget/issues/1', schema);

      expect(result).toEqual({ id: 1, title: 'hello' });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toEqual({
        cmd: 'glab',
        args: ['api', 'projects/acme%2Fwidget/issues/1'],
        input: undefined,
      });
    });

    it('passes method and fields as JSON stdin', async () => {
      const fake = createFakeGlab([{ stdout: JSON.stringify({ id: 2 }) }]);
      const runner = createGlabRunner(fake.run);
      const schema = z.object({ id: z.number() });

      const result = await runner.api(
        'projects/acme%2Fwidget/issues',
        schema,
        {
          method: 'POST',
          fields: { title: 'x', labels: 'bug,agent' },
        }
      );

      expect(result).toEqual({ id: 2 });
      expect(fake.calls[0].cmd).toBe('glab');
      expect(fake.calls[0].args).toEqual([
        'api',
        'projects/acme%2Fwidget/issues',
        '--method',
        'POST',
        '--input',
        '-',
        '-H',
        'Content-Type: application/json',
      ]);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        title: 'x',
        labels: 'bug,agent',
      });
    });

    it('defaults to POST when fields are given without a method', async () => {
      const fake = createFakeGlab([{ stdout: '{}' }]);
      const runner = createGlabRunner(fake.run);

      await runner.api('test', z.object({}), { fields: { a: 1 } });

      const methodIndex = fake.calls[0].args.indexOf('--method');
      expect(methodIndex).toBeGreaterThan(-1);
      expect(fake.calls[0].args[methodIndex + 1]).toBe('POST');
      expect(fake.calls[0].args).toContain('--input');
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({ a: 1 });
    });

    it('sends arrays as JSON arrays in stdin', async () => {
      const fake = createFakeGlab([{ stdout: '{}' }]);
      const runner = createGlabRunner(fake.run);

      await runner.api('test', z.object({}), {
        fields: { reviewer_ids: [1, 2] },
      });

      expect(fake.calls[0].args).toContain('--input');
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        reviewer_ids: [1, 2],
      });
    });

    it('throws ParseError naming the endpoint on zod mismatch', async () => {
      const fake = createFakeGlab([
        { stdout: JSON.stringify({ id: 'not-a-number' }) },
      ]);
      const runner = createGlabRunner(fake.run);
      const schema = z.object({ id: z.number() });

      await expect(
        runner.api('projects/acme%2Fwidget/issues/1', schema)
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(ParseError);
        const parse = err as ParseError;
        expect(parse.source).toBe('projects/acme%2Fwidget/issues/1');
        expect(parse.code).toBe('parse');
        return true;
      });
    });

    it('propagates CliError on non-zero glab exit', async () => {
      const error = new CliError(1, 'not found', 'glab');
      const fake = createFakeGlab([{ error }]);
      const runner = createGlabRunner(fake.run);

      await expect(runner.api('x', z.object({}))).rejects.toBe(error);
    });
  });

  describe('graphql', () => {
    it('sends scalar variables as -F flags and query as -f flag', async () => {
      const fake = createFakeGlab([
        { stdout: JSON.stringify({ data: { project: { id: 'gid://' } } }) },
      ]);
      const runner = createGlabRunner(fake.run);
      const schema = z.object({ project: z.object({ id: z.string() }) });
      const query =
        'query GetProject($fullPath:String!) { project(fullPath: $fullPath) { id } }';

      const result = await runner.graphql(
        query,
        { fullPath: 'acme/widget' },
        schema
      );

      expect(result).toEqual({ project: { id: 'gid://' } });
      const args = fake.calls[0].args;
      expect(args).toContain('-f');
      expect(args[args.indexOf('-f') + 1]).toBe(`query=${query}`);
      expect(args).toContain('fullPath=acme/widget');
    });

    it('sends null, boolean, and number scalars as -F flags', async () => {
      const fake = createFakeGlab([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGlabRunner(fake.run);

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
      const fake = createFakeGlab([
        {
          stdout: JSON.stringify({
            data: { workItemUpdate: { workItem: { id: 'W_1' } } },
          }),
        },
      ]);
      const runner = createGlabRunner(fake.run);
      const schema = z.object({
        workItemUpdate: z.object({
          workItem: z.object({ id: z.string() }),
        }),
      });
      const query =
        'mutation($input: WorkItemUpdateInput!) { workItemUpdate(input: $input) { workItem { id } } }';
      const variables = { input: { id: 'W_1', title: 'new title' } };

      const result = await runner.graphql(query, variables, schema);

      expect(result).toEqual({ workItemUpdate: { workItem: { id: 'W_1' } } });
      expect(fake.calls[0].args).toEqual(['api', 'graphql', '--input', '-']);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        query,
        variables,
      });
    });

    it('switches to --input when any variable is an array', async () => {
      const fake = createFakeGlab([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGlabRunner(fake.run);

      await runner.graphql('q', { items: [1, 2] }, z.object({}));

      expect(fake.calls[0].args).toEqual(['api', 'graphql', '--input', '-']);
      expect(JSON.parse(fake.calls[0].input ?? '{}')).toEqual({
        query: 'q',
        variables: { items: [1, 2] },
      });
    });

    it('throws CliError with GraphQL error messages from a 200 response', async () => {
      const fake = createFakeGlab([
        {
          stdout: JSON.stringify({
            errors: [{ message: 'boom' }, { message: 'bad input' }],
          }),
        },
      ]);
      const runner = createGlabRunner(fake.run);

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
      const fake = createFakeGlab([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGlabRunner(fake.run);
      const query = 'query($n:Int!) { issue(iid: $n) { title } }';

      await runner.graphql(query, { n: 42 }, z.object({}));

      const args = fake.calls[0].args;
      const queryArg = args[args.indexOf('-f') + 1];
      expect(queryArg).toBe(`query=${query}`);
      expect(queryArg).not.toContain('42');
    });
  });

  describe('raw', () => {
    it('runs an arbitrary glab subcommand and returns stdout', async () => {
      const fake = createFakeGlab([{ stdout: 'diff content' }]);
      const runner = createGlabRunner(fake.run);

      const result = await runner.raw(['mr', 'diff', '3', '-R', 'acme/widget']);

      expect(result).toBe('diff content');
      expect(fake.calls[0]).toEqual({
        cmd: 'glab',
        args: ['mr', 'diff', '3', '-R', 'acme/widget'],
        input: undefined,
      });
    });
  });

  describe('hostile input', () => {
    const hostile = '$(rm -rf ~)"\n\'hello';

    it('sends hostile REST fields as JSON stdin, not shell', async () => {
      const fake = createFakeGlab([{ stdout: '{}' }]);
      const runner = createGlabRunner(fake.run);

      await runner.api('test', z.object({}), {
        method: 'POST',
        fields: { title: hostile },
      });

      const call = fake.calls[0];
      expect(call.args).toEqual([
        'api',
        'test',
        '--method',
        'POST',
        '--input',
        '-',
        '-H',
        'Content-Type: application/json',
      ]);
      expect(JSON.parse(call.input ?? '{}')).toEqual({ title: hostile });
      expect(call.args.some((arg) => arg.includes(hostile))).toBe(false);
    });

    it('sends hostile GraphQL scalar as -F data, never into the query', async () => {
      const fake = createFakeGlab([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGlabRunner(fake.run);
      const query = 'query($x:String!) { x }';

      await runner.graphql(query, { x: hostile }, z.object({}));

      const args = fake.calls[0].args;
      expect(args).toContain(`x=${hostile}`);
      const queryArg = args[args.indexOf('-f') + 1];
      expect(queryArg).toBe(`query=${query}`);
      expect(queryArg).not.toContain(hostile);
    });

    it('sends hostile GraphQL nested value inside JSON stdin body', async () => {
      const fake = createFakeGlab([{ stdout: JSON.stringify({ data: {} }) }]);
      const runner = createGlabRunner(fake.run);
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
