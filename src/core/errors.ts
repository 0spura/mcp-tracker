export type TrackerErrorCode =
  | 'cli'
  | 'timeout'
  | 'parse'
  | 'config'
  | 'unsupported';

export class TrackerError extends Error {
  readonly code: TrackerErrorCode;

  constructor(code: TrackerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'TrackerError';
  }
}

export class CliError extends TrackerError {
  readonly exitCode: number;
  readonly stderr: string;

  constructor(exitCode: number, stderr: string, cmd?: string) {
    const message = cmd
      ? `command "${cmd}" exited with code ${exitCode}: ${stderr.trim()}`
      : `command exited with code ${exitCode}: ${stderr.trim()}`;
    super('cli', message);
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.name = 'CliError';
  }
}

export class TimeoutError extends TrackerError {
  readonly command: string;
  readonly deadlineMs: number;

  constructor(command: string, deadlineMs: number) {
    super('timeout', `command "${command}" timed out after ${deadlineMs}ms`);
    this.command = command;
    this.deadlineMs = deadlineMs;
    this.name = 'TimeoutError';
  }
}

export class ParseError extends TrackerError {
  readonly source: string;

  constructor(source: string, message: string) {
    super('parse', `parse error in ${source}: ${message}`);
    this.source = source;
    this.name = 'ParseError';
  }
}

export class ConfigError extends TrackerError {
  readonly filePath: string;
  readonly issue: string;

  constructor(filePath: string, issue: string) {
    super('config', `config error in ${filePath}: ${issue}`);
    this.filePath = filePath;
    this.issue = issue;
    this.name = 'ConfigError';
  }
}

export class UnsupportedError extends TrackerError {
  readonly capability: string;

  constructor(capability: string) {
    super('unsupported', `${capability} is not supported by this provider`);
    this.capability = capability;
    this.name = 'UnsupportedError';
  }
}
