import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { CONFIG_FILE, parseConfig, type Config } from '../config/schema.js';
import { compareUrl, parseGitHubRemote } from '../github/remote.js';
import { WORKFLOW_PATH } from '../github/workflow.js';
import { git } from '../git/exec.js';
import { currentBranch, remoteDefaultRef, remoteUrl, requireRepoRoot } from '../git/repo.js';
import { isProtected, ruleFor } from '../rules/match.js';
import { c, info, warn } from '../ui.js';
import { githubClient, requireLocalConfig, writeConfig, writeWorkflow } from './shared.js';

export interface RuleChangeOptions {
  approvals?: string;
  allowDeletion?: boolean;
  /** commander maps --no-push to push: false */
  push?: boolean;
  /** commander maps --no-commit to commit: false */
  commit?: boolean;
}

export function applyProtect(config: Config, pattern: string, approvals?: number, allowDeletion?: boolean): Config {
  const existing = config.protected.find((r) => r.pattern === pattern);
  const rule = {
    pattern,
    requiredApprovals: approvals ?? existing?.requiredApprovals ?? 1,
    allowDeletion: allowDeletion ?? existing?.allowDeletion ?? false,
  };
  const others = config.protected.filter((r) => r.pattern !== pattern);
  return { ...config, protected: [...others, rule] };
}

export function applyUnprotect(config: Config, pattern: string): Config {
  const rules = config.protected.filter((r) => r.pattern !== pattern);
  if (rules.length === config.protected.length) {
    const viaGlob = ruleFor(config, pattern);
    throw new Error(
      viaGlob
        ? `'${pattern}' is protected by pattern '${viaGlob.pattern}'. Unprotect that pattern instead.`
        : `'${pattern}' is not protected.`,
    );
  }
  return { ...config, protected: rules };
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export async function shareChange(config: Config, summary: string, opts: RuleChangeOptions): Promise<void> {
  const root = requireRepoRoot();
  const files = [CONFIG_FILE, ...(existsSync(path.join(root, WORKFLOW_PATH)) ? [WORKFLOW_PATH] : [])];

  if (opts.commit === false) {
    info(`Commit ${files.join(' and ')} and open a pull request to share this change.`);
    return;
  }

  // Rules only take effect for the team once merged into the default branch, so always go through a PR branch.
  const effective = loadConfig();
  let branch = currentBranch();
  const defaultRef = remoteDefaultRef(config.remote);
  const base = defaultRef ? defaultRef.replace(`refs/remotes/${config.remote}/`, '') : 'main';
  if (!branch || (effective && isProtected(effective.config, branch)) || branch === base) {
    branch = `vcs-protection/rules-${timestamp()}`;
    git(['switch', '-c', branch]);
    info(`${c.green('✔')} Created branch ${branch}`);
  }
  git(['add', '--', ...files]);
  git(['commit', '-m', `chore(vcs-protection): ${summary}`, '--', ...files]);
  info(`${c.green('✔')} Committed ${files.join(', ')} on ${branch}`);

  if (opts.push === false) {
    info(`Push ${branch} and open a pull request into ${base}.`);
    return;
  }
  git(['push', '-u', config.remote, branch]);
  info(`${c.green('✔')} Pushed ${branch}`);

  const client = githubClient(config);
  if (client) {
    try {
      const pr = await client.createPull(
        `vcs-protection: ${summary}`,
        branch,
        base,
        `Branch protection rule change: **${summary}**.\n\nIt takes effect for everyone once this is approved and merged.`,
      );
      info(`${c.green('✔')} Opened pull request: ${pr.html_url}`);
      return;
    } catch (err) {
      warn(`Could not open the pull request automatically: ${(err as Error).message}`);
    }
  }
  const url = remoteUrl(config.remote);
  const repo = url ? parseGitHubRemote(url) : null;
  info(repo ? `Open the pull request: ${compareUrl(repo, base, branch)}` : `Open a pull request from ${branch} into ${base}.`);
}

function afterEdit(config: Config): void {
  const root = requireRepoRoot();
  if (existsSync(path.join(root, WORKFLOW_PATH))) writeWorkflow(config);
}

export async function protect(pattern: string, opts: RuleChangeOptions): Promise<void> {
  const { file, config } = requireLocalConfig();
  const approvals = opts.approvals !== undefined ? Number(opts.approvals) : undefined;
  if (approvals !== undefined && (!Number.isInteger(approvals) || approvals < 0)) {
    throw new Error(`Invalid --approvals: ${opts.approvals}`);
  }
  const next = applyProtect(config, pattern, approvals, opts.allowDeletion);
  writeConfig(file, next);
  afterEdit(next);
  const rule = next.protected.find((r) => r.pattern === pattern)!;
  info(`${c.green('✔')} '${pattern}' is now protected (${rule.requiredApprovals} approval(s) required).`);
  await shareChange(next, `protect ${pattern}`, opts);
}

export async function unprotect(pattern: string, opts: RuleChangeOptions): Promise<void> {
  const { file, config } = requireLocalConfig();
  const next = applyUnprotect(config, pattern);
  writeConfig(file, next);
  afterEdit(next);
  info(`${c.green('✔')} '${pattern}' removed from protected branches.`);
  info(c.dim('  It stays protected for everyone until this change is merged into the default branch.'));
  await shareChange(next, `unprotect ${pattern}`, opts);
}

/** A partial change to the settings outside `protected` (what the studio's settings form edits). */
export interface SettingsPatch {
  github?: Partial<Omit<Config['github'], 'poisonPill'>> & { poisonPill?: Partial<Config['github']['poisonPill']> };
  bypass?: Partial<Config['bypass']>;
  failMode?: Config['failMode'];
}

/**
 * Change guard/bypass/failMode settings in the working-tree config, validate the result with the
 * schema, regenerate the workflow, and share the change through a PR like `protect` does.
 */
export async function updateSettings(patch: SettingsPatch, opts: RuleChangeOptions): Promise<void> {
  const { file, config } = requireLocalConfig();
  const merged = {
    ...config,
    ...(patch.failMode ? { failMode: patch.failMode } : {}),
    bypass: { ...config.bypass, ...patch.bypass },
    github: {
      ...config.github,
      ...patch.github,
      poisonPill: { ...config.github.poisonPill, ...patch.github?.poisonPill },
    },
  };
  // Throws with the list of invalid fields, exactly like a hand-edited file would.
  const next = parseConfig(JSON.stringify(merged), CONFIG_FILE);
  writeConfig(file, next);
  afterEdit(next);
  info(`${c.green('✔')} Settings updated in ${CONFIG_FILE}.`);
  info(c.dim('  They take effect for everyone once this change is merged into the default branch.'));
  await shareChange(next, 'update settings', opts);
}
