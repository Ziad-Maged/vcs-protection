import { spawnSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Run git and return the raw result without throwing on a non-zero exit. */
export function gitRaw(args: string[], opts: GitOptions = {}): GitResult {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Run git and return trimmed stdout; throws on a non-zero exit. */
export function git(args: string[], opts: GitOptions = {}): string {
  const res = gitRaw(args, opts);
  if (res.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

/** Run git and return trimmed stdout, or null on a non-zero exit. */
export function gitMaybe(args: string[], opts: GitOptions = {}): string | null {
  const res = gitRaw(args, opts);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Run git and report only whether it exited 0. */
export function gitOk(args: string[], opts: GitOptions = {}): boolean {
  return gitRaw(args, opts).code === 0;
}
