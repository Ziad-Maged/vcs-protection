import path from 'node:path';
import { readAuditLog } from '../audit/log.js';
import { checkApprovals, STATUS_CONTEXT, summarizeReviews, type ApprovalCheck } from '../github/guard.js';
import type { PullRequest } from '../github/client.js';
import { git, gitMaybe } from '../git/exec.js';
import { requireRepoRoot } from '../git/repo.js';
import { ruleFor } from '../rules/match.js';
import { VERSION } from '../version.js';
import { c, info } from '../ui.js';
import { githubClient, requireEffectiveConfig, writeWorkflow } from './shared.js';

export function githubSetup(opts: { pin?: string }): void {
  const root = requireRepoRoot();
  const { config } = requireEffectiveConfig();
  const file = writeWorkflow(config, opts.pin ?? VERSION);
  info(`${c.green('✔')} Wrote ${path.relative(root, file)} (runs vcs-protection@${opts.pin ?? VERSION})`);
  info('');
  info('Commit it through a pull request. Once it is on the default branch, the guard will:');
  info('  • revert pushes to protected branches that did not come from an approved PR (saving them on a rescue branch)');
  info('  • open an issue describing each violation');
  info(`  • post a '${STATUS_CONTEXT}' status on pull requests into protected branches`);
  info(c.dim(`Check Settings → Actions → General → Workflow permissions allows "Read and write permissions".`));
}

export interface AuditOptions {
  since?: string;
  limit?: string;
}

/** Scan protected branches on the remote for commits that didn't land through an approved PR. */
export async function audit(opts: AuditOptions): Promise<number> {
  const { config } = requireEffectiveConfig();
  let problems = 0;

  const bypasses = readAuditLog();
  info(c.bold(`Local bypasses (${bypasses.length})`));
  for (const b of bypasses) info(`  ${b.time}  ${b.user}  ${b.hook}  ${b.ref}  ${b.newSha.slice(0, 7)}  "${b.reason}"`);

  const client = githubClient(config);
  if (!client) {
    info('');
    info(c.yellow('Skipping remote history audit: needs a GitHub remote and a token (GITHUB_TOKEN, GH_TOKEN or `gh auth login`).'));
    return bypasses.length ? 1 : 0;
  }

  const refs = (gitMaybe(['for-each-ref', '--format=%(refname)', `refs/remotes/${config.remote}/`]) ?? '')
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'));
  const prCache = new Map<number, ApprovalCheck>();

  for (const ref of refs) {
    const branch = ref.slice(`refs/remotes/${config.remote}/`.length);
    const rule = ruleFor(config, branch);
    if (!rule) continue;
    const args = ['rev-list', '--first-parent', `--max-count=${opts.limit ?? '50'}`];
    if (opts.since) args.push(`--since=${opts.since}`);
    const shas = git([...args, ref]).split('\n').filter(Boolean);
    info('');
    info(c.bold(`${branch}: checking ${shas.length} commit(s)`));

    for (const sha of shas) {
      const prs: PullRequest[] = await client.pullsForCommit(sha);
      const pr = prs.find((p) => p.merged_at && p.base.ref === branch);
      const subject = gitMaybe(['log', '-1', '--format=%s (%an)', sha]) ?? '';
      if (!pr) {
        problems++;
        info(`  ${c.red('✖')} ${sha.slice(0, 7)} not from a merged pull request: ${subject}`);
        continue;
      }
      let check = prCache.get(pr.number);
      if (!check) {
        check = checkApprovals(summarizeReviews(await client.reviews(pr.number), pr.user?.login), rule);
        prCache.set(pr.number, check);
      }
      if (!check.ok) {
        problems++;
        info(`  ${c.red('✖')} ${sha.slice(0, 7)} PR #${pr.number}: ${check.description}: ${subject}`);
      } else {
        info(`  ${c.green('✔')} ${sha.slice(0, 7)} PR #${pr.number} (${check.description})`);
      }
    }
  }
  info('');
  info(problems ? c.red(`${problems} problem(s) found.`) : c.green('No problems found.'));
  return problems || bypasses.length ? 1 : 0;
}
