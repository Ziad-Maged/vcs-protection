import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'dist/cli.js');
const WRAPPER = path.join(ROOT, 'scripts/postinstall.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vcsp-pi-'));
const home = path.join(tmp, 'home');
const globalConfig = path.join(tmp, 'gitconfig');

const HOOKS = ['reference-transaction', 'pre-commit', 'pre-merge-commit', 'pre-push', 'post-checkout', 'post-merge'];

const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  CI: '',
  VCS_PROTECTION_SKIP_INSTALL: '',
  npm_config_global: '',
  npm_config_location: '',
  INIT_CWD: '',
};

function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

const gitOk = (cwd: string, ...args: string[]) => {
  const r = run('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
  return r.out.trim();
};

/** A copy of the built package at `dir`, the way npm lays it out (package.json + dist + scripts). */
function installPackageAt(dir: string): string {
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  copyFileSync(CLI, path.join(dir, 'dist/cli.js'));
  copyFileSync(WRAPPER, path.join(dir, 'scripts/postinstall.mjs'));
  return path.join(dir, 'scripts/postinstall.mjs');
}

const manifest = (deps: Record<string, string>, extra: object = {}) =>
  JSON.stringify({ name: 'app', version: '1.0.0', devDependencies: deps, ...extra });

/** A git repository that depends on the package, installed under node_modules. Returns [repo, wrapper]. */
function project(name: string, deps: Record<string, string> = { 'vcs-protection': '^1.0.0' }): [string, string] {
  const repo = path.join(tmp, name);
  mkdirSync(repo, { recursive: true });
  gitOk(repo, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'package.json'), manifest(deps));
  return [repo, installPackageAt(path.join(repo, 'node_modules', 'vcs-protection'))];
}

/** Run the wrapper the way npm does: from the package dir, with INIT_CWD set to where `npm install` ran. */
const postinstall = (wrapper: string, initCwd: string, extraEnv: Record<string, string> = {}) =>
  run(process.execPath, [wrapper], path.dirname(path.dirname(wrapper)), { INIT_CWD: initCwd, ...extraEnv });

const hookFile = (repo: string, hook: string) => path.join(repo, '.git', 'hooks', hook);
const managed = (repo: string, hook: string) =>
  existsSync(hookFile(repo, hook)) && readFileSync(hookFile(repo, hook), 'utf8').includes('# vcs-protection:managed');
const templateDir = () => run('git', ['config', '--global', 'init.templateDir'], tmp).out.trim();

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('Build first: npm run build');
  mkdirSync(home, { recursive: true });
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n\temail = tester@example.com\n');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('postinstall: local (dependency) install', () => {
  it('installs every hook, pointing at the copy in node_modules', () => {
    const [repo, wrapper] = project('local');
    const r = postinstall(wrapper, repo);
    expect(r.code, r.out).toBe(0);
    for (const hook of HOOKS) expect(managed(repo, hook), hook).toBe(true);
    expect(readFileSync(hookFile(repo, 'pre-commit'), 'utf8')).toContain('node_modules/vcs-protection/dist/cli.js');
    expect(r.out).toContain('No .vcs-protection.json yet');
  });

  it('uses the failMode from the config and chains an existing hook', () => {
    const [repo, wrapper] = project('with-config');
    writeFileSync(path.join(repo, '.vcs-protection.json'), JSON.stringify({ version: 1, protected: [{ pattern: 'main' }], failMode: 'closed' }));
    writeFileSync(hookFile(repo, 'pre-push'), '#!/bin/sh\nexit 0\n');
    const r = postinstall(wrapper, repo);
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(hookFile(repo, 'pre-commit'), 'utf8')).toContain("VCSP_FAIL='closed'");
    expect(existsSync(hookFile(repo, 'pre-push.local'))).toBe(true);
    expect(r.out).not.toContain('No .vcs-protection.json yet');
  });

  it('works when npm runs from a subdirectory of the repository', () => {
    const [repo, wrapper] = project('subdir');
    const sub = path.join(repo, 'packages', 'api');
    mkdirSync(sub, { recursive: true });
    expect(postinstall(wrapper, sub).code).toBe(0);
    expect(managed(repo, 'reference-transaction')).toBe(true);
  });

  it('is skipped when CI or VCS_PROTECTION_SKIP_INSTALL is set', () => {
    const [repo, wrapper] = project('skipped');
    expect(postinstall(wrapper, repo, { CI: 'true' }).code).toBe(0);
    expect(postinstall(wrapper, repo, { VCS_PROTECTION_SKIP_INSTALL: '1' }).code).toBe(0);
    expect(existsSync(hookFile(repo, 'pre-commit'))).toBe(false);
  });

  it('does nothing outside a git repository', () => {
    const dir = path.join(tmp, 'not-a-repo');
    const wrapper = installPackageAt(path.join(dir, 'node_modules', 'vcs-protection'));
    const r = postinstall(wrapper, dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('not inside a git working tree');
  });

  it('installs into the repository that owns node_modules, not the one npm ran in (--prefix)', () => {
    const [repo, wrapper] = project('prefix-target');
    const [elsewhere] = project('prefix-invoker', {});
    expect(postinstall(wrapper, elsewhere).code).toBe(0);
    expect(managed(repo, 'pre-commit')).toBe(true);
    expect(existsSync(hookFile(elsewhere, 'pre-commit'))).toBe(false);
  });

  it('skips transitive installs, but accepts workspace dependencies', () => {
    const [transitive, w1] = project('transitive', { 'some-lib': '^1.0.0' });
    expect(postinstall(w1, transitive).code).toBe(0);
    expect(existsSync(hookFile(transitive, 'pre-commit'))).toBe(false);

    const [mono, w2] = project('monorepo', {});
    writeFileSync(path.join(mono, 'package.json'), manifest({}, { workspaces: ['packages/*'] }));
    mkdirSync(path.join(mono, 'packages', 'api'), { recursive: true });
    writeFileSync(path.join(mono, 'packages', 'api', 'package.json'), manifest({ 'vcs-protection': '^1.0.0' }));
    expect(postinstall(w2, mono).code).toBe(0);
    expect(managed(mono, 'pre-commit')).toBe(true);
  });

  it('accepts a dependency of a pnpm workspace package, and skips dlx caches', () => {
    const [mono, wrapper] = project('pnpm-mono', {});
    writeFileSync(path.join(mono, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - '!apps/ignored'\n");
    mkdirSync(path.join(mono, 'apps', 'web'), { recursive: true });
    writeFileSync(path.join(mono, 'apps', 'web', 'package.json'), manifest({ 'vcs-protection': '^1.0.0' }));
    expect(postinstall(wrapper, mono).code).toBe(0);
    expect(managed(mono, 'pre-commit')).toBe(true);

    const [repo] = project('dlx-user');
    const dlx = installPackageAt(path.join(tmp, 'pnpm-store', 'dlx', 'x1', 'node_modules', 'vcs-protection'));
    expect(postinstall(dlx, repo).code).toBe(0);
    expect(existsSync(hookFile(repo, 'pre-commit'))).toBe(false);
  });

  it('skips the npx cache', () => {
    const [repo] = project('npx-user');
    const wrapper = installPackageAt(path.join(tmp, 'cache', '_npx', 'abc', 'node_modules', 'vcs-protection'));
    expect(postinstall(wrapper, repo).code).toBe(0);
    expect(existsSync(hookFile(repo, 'pre-commit'))).toBe(false);
  });

  it('installs only reference-transaction into a husky-style ignored hooks path, nothing into a tracked one', () => {
    const [husky, w1] = project('husky');
    mkdirSync(path.join(husky, '.husky', '_'), { recursive: true });
    writeFileSync(path.join(husky, '.husky', '_', '.gitignore'), '*\n');
    gitOk(husky, 'config', 'core.hooksPath', '.husky/_');
    const r = postinstall(w1, husky);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(path.join(husky, '.husky', '_', 'reference-transaction'))).toBe(true);
    expect(existsSync(path.join(husky, '.husky', '_', 'pre-commit'))).toBe(false);

    const [tracked, w2] = project('tracked-hooks');
    mkdirSync(path.join(tracked, '.githooks'));
    gitOk(tracked, 'config', 'core.hooksPath', '.githooks');
    const t = postinstall(w2, tracked);
    expect(t.code).toBe(0);
    expect(t.out).toContain('is tracked in this repository');
    expect(existsSync(path.join(tracked, '.githooks', 'reference-transaction'))).toBe(false);
  });

  it("skips the package's own repository (developing vcs-protection)", () => {
    const pkg = path.join(tmp, 'vcs-protection-dev');
    const wrapper = installPackageAt(pkg);
    gitOk(pkg, 'init', '-q', '-b', 'main');
    expect(postinstall(wrapper, pkg).code).toBe(0);
    expect(existsSync(hookFile(pkg, 'pre-commit'))).toBe(false);
  });

  it('exits 0 without dist/ (fresh checkout before a build)', () => {
    const dir = path.join(tmp, 'no-dist', 'scripts');
    mkdirSync(dir, { recursive: true });
    copyFileSync(WRAPPER, path.join(dir, 'postinstall.mjs'));
    const r = postinstall(path.join(dir, 'postinstall.mjs'), tmp);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toBe('');
  });
});

describe('postinstall: global install', () => {
  const ours = path.join(home, '.vcs-protection', 'git-template');
  const wrapper = installPackageAt(path.join(tmp, 'global', 'lib', 'node_modules', 'vcs-protection'));

  it('leaves init.templateDir alone with VCS_PROTECTION_SKIP_GLOBAL', () => {
    const r = postinstall(wrapper, tmp, { npm_config_global: 'true', VCS_PROTECTION_SKIP_GLOBAL: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('VCS_PROTECTION_SKIP_GLOBAL is set');
    expect(templateDir()).toBe('');
  });

  it('sets init.templateDir, says so, and is idempotent', () => {
    for (let i = 0; i < 2; i++) {
      const r = postinstall(wrapper, tmp, { npm_config_global: 'true' });
      expect(r.code, r.out).toBe(0);
      expect(path.resolve(templateDir())).toBe(path.resolve(ours));
      expect(r.out).toContain('changed your global git config');
      expect(r.out).toContain('vcs-protection uninstall --global');
    }
    expect(existsSync(path.join(ours, 'hooks', 'reference-transaction'))).toBe(true);
  });

  it('new clones get the hooks from the template', () => {
    const repo = path.join(tmp, 'fresh-clone');
    gitOk(tmp, 'init', '-q', repo);
    expect(managed(repo, 'reference-transaction')).toBe(true);
  });

  it('recognises its own template written with ~', () => {
    gitOk(tmp, 'config', '--global', 'init.templateDir', '~/.vcs-protection/git-template');
    const r = postinstall(wrapper, tmp, { npm_config_global: 'true' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('already set');
  });

  it('leaves a foreign init.templateDir alone', () => {
    const foreign = path.join(tmp, 'other-template');
    gitOk(tmp, 'config', '--global', 'init.templateDir', foreign);
    const r = postinstall(wrapper, tmp, { npm_config_location: 'global' });
    expect(r.code, r.out).toBe(0);
    expect(templateDir()).toBe(foreign);
    expect(r.out).toContain('install --global --force');
  });
});
