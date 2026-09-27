import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('blocks forced moves of an existing protected branch (zero old value in the hook)', () => {
    // release/1.0 now exists locally at origin/main; `branch -f` reports a zero old value.
    const before = head(alice, 'release/1.0');
    const r = git(alice, 'branch', '-f', 'release/1.0', 'feature/x');
    expect(r.code, r.out).not.toBe(0);
    expect(head(alice, 'release/1.0')).toBe(before);
    const u = git(alice, 'update-ref', 'refs/heads/main', head(alice, 'feature/x'));
    expect(u.code, u.out).not.toBe(0);
    expect(u.out).not.toContain('Creating protected branch');
    expect(head(alice, 'main')).toBe(head(alice, 'origin/main'));
  });

  it('blocks pushes to the shared remote given by URL instead of by name', () => {
    // A fast-forward commit on top of origin/main (commit-tree moves no ref, so no hook runs here).
    gitOk(alice, 'fetch');
    const next = gitOk(alice, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', 'push by url');
    const r = git(alice, 'push', origin, `${next}:refs/heads/main`);
    expect(r.code).not.toBe(0);
    expect(r.out, r.out).toContain("Pushing directly to protected branch 'main'");
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

describe('attempts to get around the local rules', () => {
  const erin = path.join(tmp, 'erin');
  const configFile = path.join(erin, '.vcs-protection.json');
  /** A commit on top of origin/main that exists only locally (commit-tree moves no ref, so no hook runs). */
  const localOnly = (msg: string) => gitOk(erin, 'commit-tree', 'origin/main^{tree}', '-p', 'origin/main', '-m', msg);

  beforeAll(() => {
    gitOk(tmp, 'clone', origin, erin);
    const init = cli(erin, 'init');
    expect(init.code, init.out).toBe(0);
  });

  it('a working-tree config naming another remote does not switch the rules off', () => {
    writeFileSync(configFile, '{"version":1,"remote":"nope","protected":[]}\n');
    const r = commitFile(erin, 'redirect.txt');
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain("protected branch 'main'");
    gitOk(erin, 'reset', '-q', '--hard', 'HEAD');
  });

  it('a broken working-tree config does not hide the rules on the remote', () => {
    writeFileSync(configFile, '{');
    const r = commitFile(erin, 'broken.txt');
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain("protected branch 'main'");
    expect(r.out).not.toContain('Internal error');
    gitOk(erin, 'reset', '-q', '--hard', 'HEAD');
  });

  it('rules that cannot be read follow the failMode of the installed hooks', () => {
    // No remote: the working-tree file is the only source, and it's broken.
    const solo = path.join(tmp, 'solo');
    gitOk(tmp, 'init', '-b', 'main', solo);
    writeFileSync(path.join(solo, '.vcs-protection.json'), '{"version":1,"protected":[{"pattern":"main"}],"failMode":"closed"}\n');
    expect(cli(solo, 'init').code).toBe(0);
    writeFileSync(path.join(solo, '.vcs-protection.json'), '{');
    const r = commitFile(solo, 'x.txt');
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain('failMode is "closed": blocking the operation');
  });

  it('blocks a case-only variant of a protected branch on case-insensitive filesystems', () => {
    // Unset on case-sensitive filesystems (git config exits 1), where MAIN is a separate branch.
    if (git(erin, 'config', '--bool', 'core.ignorecase').out.trim() !== 'true') return;
    const before = head(erin, 'main');
    const r = git(erin, 'update-ref', 'refs/heads/MAIN', localOnly('case'));
    expect(r.code, r.out).not.toBe(0);
    expect(head(erin, 'main')).toBe(before);
  });

  it('blocks moving the remote-tracking ref and the branch together in one transaction', () => {
    const next = localOnly('forged sync');
    const before = head(erin, 'origin/main');
    const r = spawnSync('git', ['update-ref', '--stdin'], {
      cwd: erin,
      env,
      encoding: 'utf8',
      input: `start\nupdate refs/remotes/origin/main ${next}\nupdate refs/heads/main ${next}\ncommit\n`,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0);
    expect(head(erin, 'main')).toBe(before);
    expect(head(erin, 'origin/main')).toBe(before);
  });

  it('blocks pushes to the shared remote by relative path, file:// URL, and from a subdirectory', () => {
    const next = localOnly('push by path');
    const rel = path.relative(erin, origin);
    // git resolves a relative push URL from the top of the working tree, even in a subdirectory.
    for (const [cwd, target] of [
      [erin, rel],
      [erin, pathToFileURL(origin).href],
      [path.join(erin, 'sub'), rel],
    ] as const) {
      mkdirSync(cwd, { recursive: true });
      const r = git(cwd, 'push', target, `${next}:refs/heads/main`);
      expect(r.code, `${target}: ${r.out}`).not.toBe(0);
      expect(r.out).toContain("Pushing directly to protected branch 'main'");
    }
  });
});

describe('failMode when the CLI crashes', () => {
  it('open: warns and allows; closed: blocks', () => {
    const dave = path.join(tmp, 'dave');
    gitOk(tmp, 'clone', origin, dave);
    const crash = path.join(tmp, 'crash.mjs');
    writeFileSync(crash, 'process.exit(2);\n');
    // Install shims that point at a "CLI" that always crashes.
    const install = run(process.execPath, [CLI, 'init'], dave, { VCS_PROTECTION_CLI_PATH: crash });
    expect(install.code, install.out).toBe(0);

    const open = commitFile(dave, 'open.txt');
    expect(open.code, open.out).toBe(0);
    expect(open.out).toContain('check failed (exit 2); failMode is open');

    for (const hook of ['pre-commit', 'reference-transaction']) {
      const file = path.join(dave, '.git', 'hooks', hook);
      writeFileSync(file, readFileSync(file, 'utf8').replace("VCSP_FAIL='open'", "VCSP_FAIL='closed'"));
    }
    const before = head(dave);
    expect(commitFile(dave, 'closed.txt').code).not.toBe(0);
    expect(head(dave)).toBe(before);
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
