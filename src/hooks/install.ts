import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hooksDir } from '../git/repo.js';
import { HOOKS, MANAGED_MARKER, renderShim, type HookName } from './shim.js';

export type HookState = 'installed' | 'outdated' | 'missing' | 'foreign';

export interface HookStatus {
  hook: HookName;
  path: string;
  state: HookState;
  chained: boolean;
}

/** Absolute path of the running CLI entry (dist/cli.js when bundled). */
export function cliPath(): string {
  return process.env.VCS_PROTECTION_CLI_PATH ?? fileURLToPath(import.meta.url);
}

export function expectedShim(hook: HookName, failMode: 'open' | 'closed'): string {
  return renderShim({ hook, nodePath: process.execPath, cliPath: cliPath(), failMode });
}

function isManaged(file: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').includes(MANAGED_MARKER);
}

export interface InstallResult {
  dir: string;
  written: HookName[];
  chained: HookName[];
  warnings: string[];
}

/** Install (or refresh) the shims in `dir`, chaining any pre-existing hook as `<hook>.local`. */
export function installHooksInDir(dir: string, failMode: 'open' | 'closed', only?: HookName[]): InstallResult {
  mkdirSync(dir, { recursive: true });
  const result: InstallResult = { dir, written: [], chained: [], warnings: [] };
  for (const hook of only ?? HOOKS) {
    const file = path.join(dir, hook);
    const local = `${file}.local`;
    if (existsSync(file) && !isManaged(file)) {
      if (existsSync(local)) {
        result.warnings.push(`${hook}: both ${hook} and ${hook}.local exist; left ${hook} untouched.`);
        continue;
      }
      renameSync(file, local);
      result.chained.push(hook);
    }
    writeFileSync(file, expectedShim(hook, failMode), { encoding: 'utf8' });
    chmodSync(file, 0o755);
    result.written.push(hook);
  }
  return result;
}

export function installHooks(failMode: 'open' | 'closed', cwd?: string, only?: HookName[]): InstallResult {
  return installHooksInDir(hooksDir(cwd), failMode, only);
}

export function uninstallHooksInDir(dir: string): HookName[] {
  const removed: HookName[] = [];
  for (const hook of HOOKS) {
    const file = path.join(dir, hook);
    const local = `${file}.local`;
    if (isManaged(file)) {
      rmSync(file);
      removed.push(hook);
      if (existsSync(local)) renameSync(local, file);
    }
  }
  return removed;
}

export function uninstallHooks(cwd?: string): HookName[] {
  return uninstallHooksInDir(hooksDir(cwd));
}

export function hookStatus(failMode: 'open' | 'closed', cwd?: string): HookStatus[] {
  const dir = hooksDir(cwd);
  return HOOKS.map((hook) => {
    const file = path.join(dir, hook);
    const chained = existsSync(`${file}.local`);
    let state: HookState;
    if (!existsSync(file)) state = 'missing';
    else {
      const content = readFileSync(file, 'utf8');
      if (!content.includes(MANAGED_MARKER)) state = 'foreign';
      else state = content === expectedShim(hook, failMode) ? 'installed' : 'outdated';
    }
    return { hook, path: file, state, chained };
  });
}
