import path from 'node:path';
import { readAuditLog, type AuditEntry } from '../audit/log.js';
import { parseConfig, CONFIG_FILE, type Config } from '../config/schema.js';
import { gatherChainFacts, STATUS_CONTEXT } from '../github/guard.js';
import { judgeChain } from '../github/walk.js';
import { git, gitMaybe } from '../git/exec.js';
import { requireRepoRoot } from '../git/repo.js';
import { ruleFor } from '../rules/match.js';
import { VERSION } from '../version.js';
import { c, info } from '../ui.js';
import { githubClient, requireEffectiveConfig, workingConfig, writeWorkflow } from './shared.js';

export function githubSetup(opts: { pin?: string }): void {
  if (opts.pin !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(opts.pin)) {
    throw new Error(`Invalid --pin: '${opts.pin}' (expected a version such as 1.2.3).`);
  }
  const root = requireRepoRoot();
  // The workflow is committed together with the config, so render the config being edited.
  const config = workingConfig();
  const file = writeWorkflow(config, opts.pin ?? VERSION);
  info(`${c.green('✔')} Wrote ${path.relative(root, file)} (runs vcs-protection@${opts.pin ?? VERSION})`);
  info('');
  info('Commit it through a pull request. Once it is on the default branch, the guard will:');
  info('  • revert pushes to protected branches that did not come from an approved PR (saving them on a rescue branch)');
  info('  • open an issue describing each violation');
  info(`  • post a '${STATUS_CONTEXT}' status on pull requests into protected branches`);
  const pill = config.github.poisonPill;
  if (pill.enabled) {
    info(`  • poison pill: revert a merged commit when a critical workflow (${pill.workflows.join(', ')}) fails on it`);
  }
  info(c.dim(`Check Settings → Actions → General → Workflow permissions allows "Read and write permissions".`));
}

export interface AuditOptions {
  since?: string;
  limit?: string;
}

export interface AuditCommit {
  sha: string;
  ok: boolean;
  reason: string;
  subject: string;
}

export interface AuditReport {
  bypasses: AuditEntry[];
  /** null: no GitHub remote or no token, so only the local bypasses were read. */
  branches: { branch: string; commits: AuditCommit[] }[] | null;
  problems: number;
}

/** Judge the protected branches' recent history like the guard does (data only; see `audit`). */
export async function auditReport(opts: AuditOptions): Promise<AuditReport> {
  const { config } = requireEffectiveConfig();
  if (opts.limit !== undefined && !/^[1-9]\d*$/.test(opts.limit)) throw new Error(`Invalid --limit: '${opts.limit}' (expected a positive number).`);
  const bypasses = readAuditLog();
  const client = githubClient(config);
  if (!client) return { bypasses, branches: null, problems: 0 };

  const refs = (gitMaybe(['for-each-ref', '--format=%(refname)', `refs/remotes/${config.remote}/`]) ?? '')
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'));
  const branches: { branch: string; commits: AuditCommit[] }[] = [];
  let problems = 0;
  for (const ref of refs) {
    const branch = ref.slice(`refs/remotes/${config.remote}/`.length);
    if (!ruleFor(config, branch)) continue;
    const args = ['rev-list', '--first-parent', `--max-count=${opts.limit ?? '50'}`];
    if (opts.since) args.push(`--since=${opts.since}`);
    const shas = git([...args, ref]).split('\n').filter(Boolean);
    const commits: AuditCommit[] = [];
    branches.push({ branch, commits });
    if (shas.length === 0) continue;

    // Same judgement as the GitHub guard: each commit by the rules of the last verified commit below it.
    const raw = shas.map((sha) => ({ sha, parents: parentsOf(sha), config: configIn(sha), reported: false }));
    const below = raw[raw.length - 1]!.parents[0];
    const facts = await gatherChainFacts(client, branch, raw);
    const chain = judgeChain({ branch, boundaryConfig: below ? configIn(below) : null, pushes: [], ...facts });
    for (const cmt of chain) {
      if (!cmt.verdict.ok) problems++;
      const subject = gitMaybe(['log', '-1', '--format=%s (%an)', cmt.sha]) ?? '';
      commits.push({ sha: cmt.sha, ok: cmt.verdict.ok, reason: cmt.verdict.reason, subject });
    }
  }
  return { bypasses, branches, problems };
}

/** Scan protected branches on the remote for commits that didn't land through an approved PR. */
export async function audit(opts: AuditOptions): Promise<number> {
  const report = await auditReport(opts);
  info(c.bold(`Local bypasses (${report.bypasses.length})`));
  for (const b of report.bypasses) info(`  ${b.time}  ${b.user}  ${b.hook}  ${b.ref}  ${b.newSha.slice(0, 7)}  "${b.reason}"`);
  if (!report.branches) {
    info('');
    info(c.yellow('Skipping remote history audit: needs a GitHub remote and a token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`).'));
    return report.bypasses.length ? 1 : 0;
  }
  for (const { branch, commits } of report.branches) {
    info('');
    info(c.bold(`${branch}: checking ${commits.length} commit(s)`));
    for (const cmt of commits) {
      if (cmt.ok) info(`  ${c.green('✔')} ${cmt.sha.slice(0, 7)} ${cmt.reason}`);
      else info(`  ${c.red('✖')} ${cmt.sha.slice(0, 7)} ${cmt.reason} ${c.dim(cmt.subject)}`);
    }
  }
  info('');
  info(report.problems ? c.red(`${report.problems} problem(s) found.`) : c.green('No problems found.'));
  return report.problems || report.bypasses.length ? 1 : 0;
}

function parentsOf(sha: string): string[] {
  return git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1);
}

/** `.vcs-protection.json` in a commit's tree, or null (missing or invalid). */
function configIn(sha: string): Config | null {
  const raw = gitMaybe(['show', `${sha}:${CONFIG_FILE}`]);
  if (raw === null) return null;
  try {
    return parseConfig(raw, `${CONFIG_FILE}@${sha.slice(0, 7)}`);
  } catch {
    return null;
  }
}
