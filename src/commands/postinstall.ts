import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { CONFIG_FILE } from '../config/schema.js';
import { gitMaybe } from '../git/exec.js';
import { gitVersion, repoRoot } from '../git/repo.js';
import { cliPath, installHooks } from '../hooks/install.js';
import { c, info, warn } from '../ui.js';
import { installGlobalTemplate } from './install.js';

export const SKIP_INSTALL_ENV = 'VCS_PROTECTION_SKIP_INSTALL';

const truthy = (v: string | undefined) => !!v && !['0', 'false', ''].includes(v.trim().toLowerCase());

/** Whether npm is running this lifecycle script for `npm install --global`. */
export function isGlobalInstall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.npm_config_global === 'true' || env.npm_config_location === 'global';
}

/** Root of the installed package (the directory holding package.json and dist/). */
function packageRoot(): string {
  return path.resolve(path.dirname(cliPath()), '..');
}

function gitTooOld(): boolean {
  const [maj, min] = gitVersion();
  return maj < 2 || (maj === 2 && min < 28);
}

function setupGlobal(): void {
  const res = installGlobalTemplate(false);
  if (res.state === 'installed') {
    info(`${c.green('✔')} vcs-protection: new clones will get the git hooks automatically (init.templateDir=${res.dir}).`);
  } else {
    info(`vcs-protection: git's init.templateDir is already set to '${res.current}'; left it unchanged.`);
    info(c.dim('  Run `vcs-protection install --global --force` to replace it, or `vcs-protection init` per clone.'));
  }
}

function setupLocal(initCwd: string): void {
  const root = repoRoot(initCwd);
  if (!root) {
    info(c.dim(`vcs-protection: ${initCwd} is not inside a git working tree; no hooks installed.`));
    return;
  }
  // Developing vcs-protection itself: its own repository must not get the hooks.
  const pkg = packageRoot();
  const pkgRepo = repoRoot(pkg);
  if (!pkg.split(path.sep).includes('node_modules') && pkgRepo && path.resolve(pkgRepo) === path.resolve(root)) return;

  process.chdir(root);
  let failMode: 'open' | 'closed' = 'open';
  let hasConfig = false;
  try {
    const loaded = loadConfig();
    if (loaded) {
      failMode = loaded.config.failMode;
      hasConfig = true;
    }
  } catch (err) {
    warn(`Could not read the rules (${(err as Error).message}); installing hooks with failMode "open".`);
  }

  const hooksPath = gitMaybe(['config', 'core.hooksPath']);
  if (hooksPath) warn(`core.hooksPath is set to '${hooksPath}'; hooks are installed there and chained with existing ones.`);

  const res = installHooks(failMode);
  info(`${c.green('✔')} vcs-protection: installed git hooks in ${res.dir}: ${res.written.join(', ')}`);
  if (res.chained.length) info(`  Existing hooks kept and chained as *.local: ${res.chained.join(', ')}`);
  for (const w of res.warnings) warn(w);
  if (!hasConfig) {
    info(c.dim(`  No ${CONFIG_FILE} yet: the hooks stay inactive until it is on the remote default branch`));
    info(c.dim('  or in this working tree. Run `npx vcs-protection init` to create one.'));
  }
}

/**
 * Run by the package's npm `postinstall` script (through scripts/postinstall.mjs).
 *
 * - `npm install -g`: point git's init.templateDir at the shims, unless another template is set.
 * - `npm install` in a project: install/refresh the shims in the project's git repository
 *   (INIT_CWD is where npm was invoked).
 *
 * Never fails: a broken hook setup must not break `npm install`.
 */
export function postinstall(): void {
  const env = process.env;
  if (truthy(env[SKIP_INSTALL_ENV]) || truthy(env.CI)) return;
  try {
    if (gitTooOld()) {
      warn('git >= 2.28 is required (reference-transaction hook); skipping automatic hook setup.');
      return;
    }
    if (isGlobalInstall(env)) setupGlobal();
    else setupLocal(env.INIT_CWD || process.cwd());
  } catch (err) {
    warn(`Automatic setup skipped: ${(err as Error).message}`);
    warn('Run `vcs-protection init` in your repository to install the hooks manually.');
  }
}
