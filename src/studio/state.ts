import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readAuditLog } from '../audit/log.js';
import { currentTemplateDir, globalTemplateDir } from '../commands/install.js';
import { sameText } from '../commands/shared.js';
import { loadConfig, localConfigPath } from '../config/load.js';
import { parseConfig, type Config } from '../config/schema.js';
import { gitMaybe } from '../git/exec.js';
import { currentBranch, remoteUrl, repoRoot } from '../git/repo.js';
import { resolveToken } from '../github/client.js';
import { parseGitHubRemote, webUrl } from '../github/remote.js';
import { renderWorkflow, WORKFLOW_PATH } from '../github/workflow.js';
import { hookStatus, hooksLocation, type HookStatus } from '../hooks/install.js';
import { VERSION } from '../version.js';

export interface RepoState {
  root: string;
  branch: string | null;
  remote: { name: string; url: string | null; github: { owner: string; repo: string; web: string } | null };
  /** The rules in force (remote default branch wins), or null when there are none yet. */
  rules: { source: 'remote' | 'local'; location: string; config: Config } | null;
  /** Why the rules couldn't be read (invalid JSON or schema), if so. */
  rulesError?: string;
  /** The working-tree `.vcs-protection.json` (what forms edit), or null. */
  workingConfig: Config | null;
  workingConfigError?: string;
  /** The working-tree file differs from the rules in force (a change not merged yet). */
  unmerged: boolean;
  hooks: { dir: string; inWorkTree: boolean; ignored: boolean; hooksPath: string | null; list: HookStatus[] };
  workflow: { path: string; present: boolean; pinned: string | null; inSync: boolean | null };
  bypasses: { count: number; last: string | null };
  tokenAvailable: boolean;
}

export interface StudioState {
  version: string;
  cwd: string;
  repo: RepoState | null;
  global: { templateDir: string; current: string | null; installed: boolean; foreign: boolean };
}

let tokenCache: boolean | undefined;
/** Looking for a token may run `gh auth token`; do it once per studio session. */
function tokenAvailable(): boolean {
  if (tokenCache === undefined) tokenCache = !!resolveToken();
  return tokenCache;
}

function globalState(): StudioState['global'] {
  const templateDir = globalTemplateDir();
  const current = currentTemplateDir();
  const installed = !!current && path.resolve(current) === path.resolve(templateDir);
  return { templateDir, current, installed, foreign: !!current && !installed };
}

function repoState(root: string): RepoState {
  const errors: { rules?: string; working?: string } = {};
  let loaded: ReturnType<typeof loadConfig> = null;
  try {
    loaded = loadConfig();
  } catch (err) {
    errors.rules = (err as Error).message;
  }
  let workingConfig: Config | null = null;
  const file = localConfigPath();
  if (file && existsSync(file)) {
    try {
      workingConfig = parseConfig(readFileSync(file, 'utf8'), file);
    } catch (err) {
      errors.working = (err as Error).message;
    }
  }
  const settings = loaded?.config ?? workingConfig;
  const remoteName = settings?.remote ?? 'origin';
  const url = remoteUrl(remoteName);
  const gh = url ? parseGitHubRemote(url) : null;
  const where = hooksLocation();
  const failMode = settings?.failMode ?? 'open';

  const wfFile = path.join(root, WORKFLOW_PATH);
  const workflow: RepoState['workflow'] = { path: WORKFLOW_PATH, present: false, pinned: null, inSync: null };
  if (existsSync(wfFile)) {
    const current = readFileSync(wfFile, 'utf8');
    workflow.present = true;
    workflow.pinned = current.match(/vcs-protection@([^\s]+)/)?.[1] ?? null;
    const target = workingConfig ?? loaded?.config;
    workflow.inSync = target ? sameText(current, renderWorkflow(target, workflow.pinned ?? VERSION)) : null;
  }
  const bypasses = readAuditLog();

  return {
    root,
    branch: currentBranch(),
    remote: { name: remoteName, url, github: gh ? { owner: gh.owner, repo: gh.repo, web: webUrl(gh) } : null },
    rules: loaded ? { source: loaded.source, location: loaded.location, config: loaded.config } : null,
    ...(errors.rules ? { rulesError: errors.rules } : {}),
    workingConfig,
    ...(errors.working ? { workingConfigError: errors.working } : {}),
    unmerged: !!workingConfig && !!loaded && JSON.stringify(workingConfig) !== JSON.stringify(loaded.config),
    hooks: {
      dir: where.dir,
      inWorkTree: where.inWorkTree,
      ignored: where.ignored,
      hooksPath: gitMaybe(['config', 'core.hooksPath']),
      list: hookStatus(failMode, undefined, remoteName),
    },
    workflow,
    bypasses: { count: bypasses.length, last: bypasses.at(-1)?.time ?? null },
    tokenAvailable: tokenAvailable(),
  };
}

/** Everything the studio shows, gathered from the same helpers the CLI commands use. */
export function studioState(): StudioState {
  const root = repoRoot();
  return { version: VERSION, cwd: process.cwd(), repo: root ? repoState(root) : null, global: globalState() };
}
