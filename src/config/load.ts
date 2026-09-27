import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitMaybe } from '../git/exec.js';
import { remoteDefaultRef, repoRoot } from '../git/repo.js';
import { CONFIG_FILE, parseConfig, REMOTE_NAME_RE, type Config } from './schema.js';

export type ConfigSource = 'remote' | 'local';

export interface LoadedConfig {
  config: Config;
  source: ConfigSource;
  /** Where it was read from: `<ref>:<file>` for remote, a file path for local. */
  location: string;
}

export interface LoadOptions {
  /** The shared remote as the hook shim knows it (baked in from the rules at install time). */
  remote?: string;
}

export function localConfigPath(cwd?: string): string | null {
  const root = repoRoot(cwd);
  return root ? path.join(root, CONFIG_FILE) : null;
}

function readLocal(cwd?: string): LoadedConfig | null {
  const file = localConfigPath(cwd);
  if (!file || !existsSync(file)) return null;
  return { config: parseConfig(readFileSync(file, 'utf8'), file), source: 'local', location: file };
}

/**
 * Remotes whose default branch may hold the rules, most trusted first: the shim's remote, then
 * `origin`, then every other configured remote. Never taken from the working-tree file, which
 * anyone can edit.
 */
function candidateRemotes(opts: LoadOptions, cwd?: string): string[] {
  const configured = (gitMaybe(['remote'], { cwd }) ?? '').split('\n').map((s) => s.trim());
  const names = [opts.remote, 'origin', ...configured].filter((n): n is string => !!n && REMOTE_NAME_RE.test(n));
  return [...new Set(names)];
}

/**
 * Load the effective rules.
 *
 * The copy on a remote's default branch wins over the working tree, so a teammate cannot relax
 * the rules by editing (or breaking) the file on a feature branch. A rules change only takes
 * effect once its pull request is merged and fetched. The working-tree copy is used only when no
 * remote has a config yet (initial setup) or there is no remote.
 */
export function loadConfig(cwd?: string, opts: LoadOptions = {}): LoadedConfig | null {
  for (const remote of candidateRemotes(opts, cwd)) {
    const defaultRef = remoteDefaultRef(remote, cwd);
    if (!defaultRef) continue;
    const spec = `${defaultRef}:${CONFIG_FILE}`;
    const raw = gitMaybe(['show', spec], { cwd });
    if (raw !== null) {
      return { config: parseConfig(raw, spec), source: 'remote', location: spec };
    }
  }
  return readLocal(cwd);
}
