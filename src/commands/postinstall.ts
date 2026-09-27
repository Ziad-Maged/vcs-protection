import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { loadConfig } from '../config/load.js';
import { CONFIG_FILE } from '../config/schema.js';
import { gitMaybe } from '../git/exec.js';
import { gitVersion, repoRoot } from '../git/repo.js';
import { cliPath, hooksLocation, installHooks } from '../hooks/install.js';
import type { HookName } from '../hooks/shim.js';
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

/** The project whose node_modules holds this package: the directory above the first `node_modules`. */
export function dependentProject(pkg: string): string | null {
  const parts = pkg.split(path.sep);
  const i = parts.indexOf('node_modules');
  return i > 0 ? parts.slice(0, i).join(path.sep) || path.sep : null;
}

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

function listsDependency(manifest: Record<string, unknown> | null, name: string): boolean {
  if (!manifest) return false;
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some(
    (k) => typeof manifest[k] === 'object' && manifest[k] !== null && name in (manifest[k] as object),
  );
}

/** Workspace package directories of an npm/yarn workspaces root (`packages/*` style globs). */
function workspaceDirs(project: string, manifest: Record<string, unknown>): string[] {
  const ws = manifest.workspaces;
  const globs = Array.isArray(ws) ? ws : Array.isArray((ws as { packages?: unknown })?.packages) ? (ws as { packages: string[] }).packages : [];
  return expandGlobs(project, globs);
}

/** Package globs of a pnpm workspace (`pnpm-workspace.yaml`, the `packages:` list). */
function pnpmWorkspaceDirs(project: string): string[] {
  let yaml: string;
  try {
    yaml = readFileSync(path.join(project, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) inPackages = true;
    else if (/^\S/.test(line)) inPackages = false;
    else if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m && !m[1]!.startsWith('!')) globs.push(m[1]!.trim());
    }
  }
  return expandGlobs(project, globs);
}

function expandGlobs(project: string, globs: unknown[]): string[] {
  const dirs: string[] = [];
  for (const g of globs.filter((x): x is string => typeof x === 'string')) {
    const parts = g.replace(/\/+$/, '').split('/');
    let level = [project];
    for (const part of parts) {
      const match = picomatch(part);
      level = level.flatMap((d) => {
        try {
          return readdirSync(d, { withFileTypes: true })
            .filter((e) => e.isDirectory() && e.name !== 'node_modules' && match(e.name))
            .map((e) => path.join(d, e.name));
        } catch {
          return [];
        }
      });
    }
    dirs.push(...level);
  }
  return dirs;
}

/**
 * Whether the project depends on this package directly (in its package.json or a workspace's),
 * as opposed to getting it as a dependency of a dependency.
 */
export function isDirectDependency(project: string, name: string): boolean {
  const manifest = readJson(path.join(project, 'package.json'));
  if (!manifest) return false;
  if (listsDependency(manifest, name)) return true;
  const dirs = [...workspaceDirs(project, manifest), ...pnpmWorkspaceDirs(project)];
  return dirs.some((d) => listsDependency(readJson(path.join(d, 'package.json')), name));
}

function setupLocal(): void {
  const pkg = packageRoot();
  const parts = pkg.split(path.sep);
  // `npx vcs-protection@x ...` installs into npm's cache: hooks must not point there.
  if (parts.includes('_npx') || parts.includes('dlx')) return; // npx / pnpm dlx caches
  // Developing vcs-protection itself (not inside node_modules), or a linked install: nothing to do.
  const project = dependentProject(pkg);
  if (!project) return;

  const root = repoRoot(project);
  if (!root) {
    info(c.dim(`vcs-protection: ${project} is not inside a git working tree; no hooks installed.`));
    return;
  }
  const name = (readJson(path.join(pkg, 'package.json'))?.name as string | undefined) ?? 'vcs-protection';
  if (!isDirectDependency(project, name)) return; // pulled in by another package: not our call

  process.chdir(root);
  let failMode: 'open' | 'closed' = 'open';
  let remote = 'origin';
  let hasConfig = false;
  try {
    const loaded = loadConfig();
    if (loaded) {
      failMode = loaded.config.failMode;
      remote = loaded.config.remote;
      hasConfig = true;
    }
  } catch (err) {
    warn(`Could not read the rules (${(err as Error).message}); installing hooks with failMode "open".`);
  }

  const where = hooksLocation();
  let only: HookName[] | undefined;
  if (where.inWorkTree && !where.ignored) {
    // A tracked hooks directory is shared through git: shims with personal absolute paths don't belong there.
    warn(`core.hooksPath (${where.dir}) is tracked in this repository; not installing hooks there automatically.`);
    warn('Call `npx vcs-protection hook <name> "$@"` from those hooks, or run `npx vcs-protection init` to install them anyway.');
    return;
  }
  if (where.inWorkTree) {
    // Husky-style generated directory: husky rewrites its own hooks on every install, but never
    // reference-transaction, which is the one that does the enforcement.
    only = ['reference-transaction'];
    warn(`core.hooksPath (${where.dir}) is managed by another tool (e.g. husky); installing only reference-transaction there.`);
    warn('For the early pre-commit/pre-push messages, add `npx vcs-protection hook pre-push "$@"` (etc.) to those hooks.');
  } else if (gitMaybe(['config', 'core.hooksPath'])) {
    warn(`core.hooksPath is set to '${where.dir}'; hooks are installed there and chained with existing ones.`);
  }

  const res = installHooks(failMode, undefined, only, remote);
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
 * - `npm install` in a project that depends on it directly: install/refresh the shims in the git
 *   repository of the project whose node_modules holds the package (not INIT_CWD, which is only
 *   where npm was invoked and can be another repository with `--prefix`).
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
    else setupLocal();
  } catch (err) {
    warn(`Automatic setup skipped: ${(err as Error).message}`);
    warn('Run `vcs-protection init` in your repository to install the hooks manually.');
  }
}
