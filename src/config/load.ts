import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitMaybe } from '../git/exec.js';
import { remoteDefaultRef, repoRoot } from '../git/repo.js';
import { CONFIG_FILE, parseConfig, type Config } from './schema.js';

export type ConfigSource = 'remote' | 'local';

export interface LoadedConfig {
  config: Config;
  source: ConfigSource;
  /** Where it was read from: `<ref>:<file>` for remote, a file path for local. */
  location: string;
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
 * Load the effective rules.
 *
 * The copy on the remote's default branch wins over the working tree, so a teammate cannot
 * relax the rules by editing the file on a feature branch. A rules change only takes effect
 * once its pull request is merged and fetched. The working-tree copy is used when the remote
 * has no config yet (initial setup) or there is no remote.
 */
export function loadConfig(cwd?: string): LoadedConfig | null {
  const local = readLocal(cwd);
  const remote = local?.config.remote ?? 'origin';
  const defaultRef = remoteDefaultRef(remote, cwd);
  if (defaultRef) {
    const spec = `${defaultRef}:${CONFIG_FILE}`;
    const raw = gitMaybe(['show', spec], { cwd });
    if (raw !== null) {
      return { config: parseConfig(raw, spec), source: 'remote', location: spec };
    }
  }
  return local;
}
