import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, gitMaybe } from '../git/exec.js';
import { installHooksInDir, uninstallHooks, uninstallHooksInDir } from '../hooks/install.js';
import { c, info, warn } from '../ui.js';

export function globalTemplateDir(): string {
  return path.join(os.homedir(), '.vcs-protection', 'git-template');
}

/**
 * Point git's init.templateDir at a template containing the shims, so every future
 * `git clone` / `git init` gets them. The shims do nothing in repositories without a config.
 */
export function installGlobal(opts: { force?: boolean }): void {
  const ours = globalTemplateDir();
  const current = gitMaybe(['config', '--global', 'init.templateDir']);
  if (current && path.resolve(current) !== path.resolve(ours) && !opts.force) {
    throw new Error(`init.templateDir is already set to '${current}'. Re-run with --force to replace it.`);
  }
  mkdirSync(ours, { recursive: true });
  installHooksInDir(path.join(ours, 'hooks'), 'open');
  git(['config', '--global', 'init.templateDir', ours]);
  info(`${c.green('✔')} New clones will get vcs-protection hooks automatically (init.templateDir=${ours}).`);
  info(c.dim('  Existing clones still need `vcs-protection init` (or `git init` inside them to copy the template).'));
}

export function uninstall(opts: { global?: boolean }): void {
  if (opts.global) {
    const ours = globalTemplateDir();
    const current = gitMaybe(['config', '--global', 'init.templateDir']);
    if (current && path.resolve(current) === path.resolve(ours)) {
      git(['config', '--global', '--unset', 'init.templateDir']);
    }
    if (existsSync(ours)) {
      uninstallHooksInDir(path.join(ours, 'hooks'));
      rmSync(ours, { recursive: true, force: true });
    }
    info(`${c.green('✔')} Removed the global git template.`);
    return;
  }
  const removed = uninstallHooks();
  if (removed.length === 0) warn('No vcs-protection hooks were installed in this repository.');
  else info(`${c.green('✔')} Removed hooks: ${removed.join(', ')} (chained *.local hooks were restored).`);
}
