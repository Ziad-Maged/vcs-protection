import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vcsp-it-'));
const globalConfig = path.join(tmp, 'gitconfig');

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  GITHUB_TOKEN: '',
  GH_TOKEN: '',
  VCS_PROTECTION_BYPASS: '',
};

interface Run {
  code: number;
  out: string;
}

function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
const gitOk = (cwd: string, ...args: string[]) => {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
  return r.out.trim();
};
const gitConfig = (cwd: string, key: string) => {
  const r = git(cwd, 'config', '--bool', key);
  return r.code === 0 ? r.out.trim() : null;
};
const caseInsensitiveFs = (cwd: string) => {
  const configured = gitConfig(cwd, 'core.ignorecase');
  if (configured === 'true' || configured === 'false') return configured === 'true';
  const dir = path.join(cwd, '.git');
  const name = `vcsp-case-check-${process.pid}-${Date.now()}`;
  const probe = path.join(dir, name);
  const alias = path.join(dir, name.toUpperCase());
  writeFileSync(probe, '');
  try {
    return probe !== alias && existsSync(alias);
  } finally {
    rmSync(probe, { force: true });
  }
};
const bypass = (cwd: string, ...args: string[]) => run('git', args, cwd, { VCS_PROTECTION_BYPASS: 'test setup' });
const cli = (cwd: string, ...args: string[]) => run(process.execPath, [CLI, ...args], cwd);
const head = (cwd: string, ref = 'HEAD') => gitOk(cwd, 'rev-parse', ref);

function commitFile(cwd: string, name: string, content = name, extra: string[] = []): Run {
  writeFileSync(path.join(cwd, name), content);
  gitOk(cwd, 'add', name);
  return git(cwd, 'commit', '-m', `add ${name}`, ...extra);
}

const origin = path.join(tmp, 'origin.git');
const alice = path.join(tmp, 'alice');
const bob = path.join(tmp, 'bob');

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('Build first: npm run build');
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n');
  gitOk(tmp, 'init', '--bare', '-b', 'main', origin);

  // Alice seeds the repository, then turns protection on and bootstraps the config with a bypass.
  gitOk(tmp, 'clone', origin, alice);
  expect(commitFile(alice, 'README.md').code).toBe(0);
  gitOk(alice, 'push', '-u', 'origin', 'main');
  const init = cli(alice, 'init', '--branches', 'main,release/*', '--approvals', '1');
  expect(init.code, init.out).toBe(0);
  gitOk(alice, 'add', '.vcs-protection.json');
  expect(bypass(alice, 'commit', '-m', 'add rules').code).toBe(0);
  expect(bypass(alice, 'push', 'origin', 'main').code).toBe(0);

  // Bob clones and installs; his rules come from origin/main.
  gitOk(tmp, 'clone', origin, bob);
  const initBob = cli(bob, 'init');
  expect(initBob.code, initBob.out).toBe(0);
  expect(initBob.out).toContain('refs/remotes/origin/main:.vcs-protection.json');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('local enforcement', () => {
  it('blocks a direct commit on a protected branch', () => {
    const before = head(alice);
    const r = commitFile(alice, 'a.txt');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Direct commits to protected branch 'main' are not allowed");
    expect(head(alice)).toBe(before);
    gitOk(alice, 'reset', '-q', 'HEAD', '--', 'a.txt');
    unlinkSync(path.join(alice, 'a.txt'));
  });

  it('blocks a direct commit even with --no-verify', () => {
    const before = head(alice);
    const r = commitFile(alice, 'b.txt', 'b', ['--no-verify']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("protected branch 'main'");
    expect(head(alice)).toBe(before);
    gitOk(alice, 'reset', '-q', 'HEAD', '--', 'b.txt');
    unlinkSync(path.join(alice, 'b.txt'));
  });

  it('allows commits and pushes on feature branches', () => {
    gitOk(alice, 'switch', '-c', 'feature/x');
    expect(commitFile(alice, 'feature.txt').code).toBe(0);
    expect(git(alice, 'push', '-u', 'origin', 'feature/x').code).toBe(0);
    gitOk(alice, 'switch', 'main');
  });

  it('blocks fast-forward and --no-ff merges into a protected branch with a PR hint', () => {
    const before = head(alice);
    const ff = git(alice, 'merge', 'feature/x');
    expect(ff.code).not.toBe(0);
    expect(ff.out).toContain("Merging into protected branch 'main' is not allowed");
    expect(ff.out).toContain('pull request');
    expect(head(alice)).toBe(before);
    // git moved the working tree before the ref update was refused; the message says how to undo it.
    const restore = ff.out.match(/git read-tree -m -u \w+ HEAD/)?.[0];
    expect(restore).toBeTruthy();
    gitOk(alice, ...restore!.split(' ').slice(1));
    expect(gitOk(alice, 'status', '--porcelain')).toBe('');

    const noff = git(alice, 'merge', '--no-ff', '--no-verify', '--no-edit', 'feature/x');
    expect(noff.code).not.toBe(0);
    expect(noff.out).toContain("Merging into protected branch 'main'");
    expect(head(alice)).toBe(before);
    git(alice, 'merge', '--abort');
    gitOk(alice, 'reset', '-q', '--hard', 'HEAD');
  });

  it('blocks pushing to a protected branch on the remote', () => {
    const r = git(alice, 'push', 'origin', 'feature/x:main');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Pushing directly to protected branch 'main' is not allowed");
    expect(head(alice, 'origin/main')).toBe(head(bob, 'origin/main'));
  });

  it('blocks deleting a protected branch on the remote', () => {
    const r = git(alice, 'push', 'origin', ':main');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Deleting protected branch 'main'");
  });

  it('allows syncing a protected branch with the remote (pull, reset to origin)', () => {
    // Simulates an approved PR landing on origin/main.
    gitOk(bob, 'switch', '-c', 'feature/y');
    expect(commitFile(bob, 'y.txt').code).toBe(0);
    gitOk(bob, 'switch', 'main');
    expect(bypass(bob, 'merge', '--ff-only', 'feature/y').code).toBe(0);
    expect(bypass(bob, 'push', 'origin', 'main').code).toBe(0);

    const pull = git(alice, 'pull', '--ff-only');
    expect(pull.code, pull.out).toBe(0);
    expect(head(alice)).toBe(head(bob));

    const reset = git(alice, 'reset', '--hard', 'HEAD~1');
    expect(reset.code, reset.out).toBe(0);
    expect(git(alice, 'reset', '--hard', 'origin/main').code).toBe(0);
  });

  it('blocks resetting a protected branch to local-only commits', () => {
    const r = git(alice, 'reset', '--hard', 'feature/x');
    expect(r.code).not.toBe(0);
    expect(head(alice)).toBe(head(alice, 'origin/main'));
  });

  it('blocks creating a protected branch from local-only commits', () => {
    const r = git(alice, 'branch', 'release/1.0', 'feature/x');
    expect(r.code).not.toBe(0);
    expect(git(alice, 'branch', 'release/1.0', 'origin/main').code).toBe(0);
  });

  it('blocks a case-only variant of a protected branch on case-insensitive filesystems', () => {
    if (!caseInsensitiveFs(alice)) return;
    const before = head(alice, 'main');
    const r = git(alice, 'update-ref', 'refs/heads/MAIN', head(alice, 'feature/x'));
    expect(r.code, r.out).not.toBe(0);
    expect(head(alice, 'main')).toBe(before);
  });

  it('logs bypasses', () => {
    const log = readFileSync(path.join(bob, '.git', 'vcs-protection', 'audit.log'), 'utf8');
    const entries = log.trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.some((e) => e.reason === 'test setup' && e.hook === 'reference-transaction')).toBe(true);
    expect(entries.some((e) => e.reason === 'test setup' && e.hook === 'pre-push')).toBe(true);
  });
});

describe('hook management', () => {
  it('chains a pre-existing hook', () => {
    const carol = path.join(tmp, 'carol');
    gitOk(tmp, 'clone', origin, carol);
    const marker = path.join(tmp, 'carol-hook-ran').replace(/\\/g, '/');
    const hook = path.join(carol, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(hook, 0o755);
    expect(cli(carol, 'init').code).toBe(0);
    expect(existsSync(`${hook}.local`)).toBe(true);
    gitOk(carol, 'switch', '-c', 'feature/z');
    expect(commitFile(carol, 'z.txt').code).toBe(0);
    expect(existsSync(marker)).toBe(true);

    expect(cli(carol, 'uninstall').code).toBe(0);
    expect(readFileSync(hook, 'utf8')).toContain('carol-hook-ran');
  });

  it('repairs a deleted hook on checkout and reports health via doctor', () => {
    const hook = path.join(alice, '.git', 'hooks', 'reference-transaction');
    unlinkSync(hook);
    expect(cli(alice, 'doctor').code).toBe(1);
    const r = git(alice, 'switch', 'feature/x');
    expect(r.out).toContain('Repaired git hooks: reference-transaction');
    expect(existsSync(hook)).toBe(true);
    gitOk(alice, 'switch', 'main');
  });
});

describe('changing the rules', () => {
  it('unprotect goes through a branch and only takes effect once merged on the remote', () => {
    const r = cli(alice, 'unprotect', 'main');
    expect(r.code, r.out).toBe(0);
    const branch = gitOk(alice, 'symbolic-ref', '--short', 'HEAD');
    expect(branch).toMatch(/^vcs-protection\/rules-/);

    // Not merged yet: main is still protected for everyone.
    gitOk(bob, 'fetch');
    gitOk(bob, 'switch', 'main');
    expect(commitFile(bob, 'still-blocked.txt').code).not.toBe(0);
    gitOk(bob, 'reset', '-q', '--hard', 'HEAD');
    rmSync(path.join(bob, 'still-blocked.txt'), { force: true });

    // "Merge the PR" on origin.
    gitOk(alice, 'switch', 'main');
    expect(bypass(alice, 'merge', '--ff-only', branch).code).toBe(0);
    expect(bypass(alice, 'push', 'origin', 'main').code).toBe(0);

    gitOk(bob, 'pull', '--ff-only');
    const list = cli(bob, 'list');
    expect(list.out).not.toMatch(/^\s+main\s/m);
    expect(commitFile(bob, 'now-allowed.txt').code).toBe(0);
  });
});
