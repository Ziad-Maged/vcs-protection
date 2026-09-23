import type { BranchRule, Config } from '../config/schema.js';
import { ruleFor } from '../rules/match.js';
import { GitHubError, type GitHubClient, type PullRequest, type Review } from './client.js';
import { compareUrl, webUrl } from './remote.js';

export const STATUS_CONTEXT = 'vcs-protection/approvals';

const isZero = (sha: string) => /^0+$/.test(sha);
const short = (sha: string) => sha.slice(0, 7);

export interface ApprovalSummary {
  approvedBy: string[];
  changesRequestedBy: string[];
}

/**
 * Latest decisive review state per reviewer. COMMENTED/PENDING reviews don't change a
 * reviewer's standing, DISMISSED clears it, and the PR author never counts.
 */
export function summarizeReviews(reviews: Review[], author: string | undefined): ApprovalSummary {
  const latest = new Map<string, Review['state']>();
  const ordered = [...reviews].sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '') || a.id - b.id);
  for (const r of ordered) {
    const login = r.user?.login;
    if (!login || login === author) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    latest.set(login, r.state);
  }
  const approvedBy: string[] = [];
  const changesRequestedBy: string[] = [];
  for (const [login, state] of latest) {
    if (state === 'APPROVED') approvedBy.push(login);
    if (state === 'CHANGES_REQUESTED') changesRequestedBy.push(login);
  }
  return { approvedBy, changesRequestedBy };
}

export interface ApprovalCheck {
  ok: boolean;
  summary: ApprovalSummary;
  description: string;
}

export function checkApprovals(summary: ApprovalSummary, rule: BranchRule): ApprovalCheck {
  const have = summary.approvedBy.length;
  const need = rule.requiredApprovals;
  if (summary.changesRequestedBy.length > 0) {
    return { ok: false, summary, description: `Changes requested by ${summary.changesRequestedBy.join(', ')}` };
  }
  if (have < need) {
    return { ok: false, summary, description: `${have}/${need} approvals` };
  }
  return { ok: true, summary, description: `${have}/${need} approvals` };
}

export interface PushEvent {
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  sender?: { login: string };
  repository?: { default_branch?: string };
}

export type ViolationKind = 'direct-push' | 'force-push' | 'insufficient-approvals' | 'deleted' | 'created';

export type Verdict =
  | { ok: true; reason: string; pr?: PullRequest }
  | { ok: false; kind: ViolationKind; reason: string; branch: string; rule: BranchRule; pr?: PullRequest };

export async function judgePush(event: PushEvent, config: Config, client: GitHubClient): Promise<Verdict> {
  if (!event.ref.startsWith('refs/heads/')) return { ok: true, reason: 'not a branch' };
  const branch = event.ref.slice('refs/heads/'.length);
  const rule = ruleFor(config, branch);
  if (!rule) return { ok: true, reason: `'${branch}' is not protected` };
  const sender = event.sender?.login;
  if (sender && config.github.bypassUsers.includes(sender)) {
    return { ok: true, reason: `${sender} is in github.bypassUsers` };
  }

  if (event.deleted) {
    if (rule.allowDeletion) return { ok: true, reason: 'deletion allowed by rule' };
    return { ok: false, kind: 'deleted', reason: `Protected branch '${branch}' was deleted.`, branch, rule };
  }

  if (event.created) {
    const base = event.repository?.default_branch;
    if (!base || base === branch) return { ok: true, reason: 'initial branch' };
    const cmp = await client.compare(base, event.after);
    if (cmp.status === 'behind' || cmp.status === 'identical') {
      return { ok: true, reason: `created from existing '${base}' history` };
    }
    return {
      ok: false,
      kind: 'created',
      reason: `Protected branch '${branch}' was created from commits that are not on '${base}'.`,
      branch,
      rule,
    };
  }

  if (event.forced) {
    return { ok: false, kind: 'force-push', reason: `Force push to protected branch '${branch}'.`, branch, rule };
  }

  const prs = await client.pullsForCommit(event.after);
  const pr = prs.find((p) => p.merged_at && p.merge_commit_sha === event.after && p.base.ref === branch);
  if (!pr) {
    return {
      ok: false,
      kind: 'direct-push',
      reason: `Commit ${short(event.after)} was pushed directly to '${branch}' instead of being merged from a pull request.`,
      branch,
      rule,
    };
  }

  const check = checkApprovals(summarizeReviews(await client.reviews(pr.number), pr.user?.login), rule);
  if (!check.ok) {
    return {
      ok: false,
      kind: 'insufficient-approvals',
      reason: `Pull request #${pr.number} was merged into '${branch}' without the required approvals (${check.description}).`,
      branch,
      rule,
      pr,
    };
  }
  return { ok: true, reason: `merged from PR #${pr.number} (${check.description})`, pr };
}

export interface RemediationResult {
  actions: string[];
  issueUrl?: string;
}

async function ignoreExists<T>(p: Promise<T>): Promise<void> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 422)) throw err;
  }
}

export async function remediatePush(
  event: PushEvent,
  verdict: Extract<Verdict, { ok: false }>,
  config: Config,
  client: GitHubClient,
): Promise<RemediationResult> {
  const { branch } = verdict;
  const actions: string[] = [];
  const revert = config.github.enforcement === 'revert';
  let rescue: string | null = null;

  if (revert) {
    if (verdict.kind === 'deleted') {
      await client.createRef(branch, event.before);
      actions.push(`Restored '${branch}' at ${short(event.before)}.`);
    } else {
      rescue = `${config.github.rescueBranchPrefix}${branch}-${short(event.after)}`;
      await ignoreExists(client.createRef(rescue, event.after));
      actions.push(`Saved the pushed commits on branch '${rescue}'.`);

      const current = await client.getRefSha(branch);
      if (current !== event.after) {
        actions.push(
          `Did NOT move '${branch}': it changed again after this push (now ${current ? short(current) : 'deleted'}). Fix it manually.`,
        );
      } else if (verdict.kind === 'created' || isZero(event.before)) {
        await client.deleteRef(branch);
        actions.push(`Deleted '${branch}', which was created from unreviewed commits.`);
      } else {
        await client.updateRef(branch, event.before, true);
        actions.push(`Reset '${branch}' back to ${short(event.before)}.`);
      }
    }
  } else {
    actions.push('Enforcement is "report": nothing was reverted.');
  }

  const repo = client.repo;
  const who = event.sender?.login ? `@${event.sender.login}` : 'unknown user';
  const lines = [
    `**vcs-protection** detected a change to protected branch \`${branch}\` that did not come through an approved pull request.`,
    '',
    `- **Who:** ${who}`,
    `- **What:** ${verdict.reason}`,
    `- **Rule:** \`${verdict.rule.pattern}\` requires ${verdict.rule.requiredApprovals} approval(s) from someone other than the PR author`,
    `- **Before:** \`${event.before}\``,
    `- **After:** \`${event.after}\``,
    ...(verdict.pr ? [`- **Pull request:** ${verdict.pr.html_url}`] : []),
    '',
    '### Actions taken',
    ...actions.map((a) => `- ${a}`),
  ];
  if (rescue) {
    lines.push(
      '',
      '### How to get these changes in properly',
      `Open a pull request from the rescue branch and get it approved: ${compareUrl(repo, branch, rescue)}`,
      '',
      'Then, in local clones that already pulled the reverted commits:',
      '```sh',
      `git fetch origin && git switch ${branch} && git reset --hard origin/${branch}`,
      '```',
    );
  }
  const issue = await client.createIssue(`vcs-protection: ${verdict.kind} on ${branch} (${short(event.after)})`, lines.join('\n'));
  actions.push(`Opened issue ${issue.html_url}`);
  return { actions, issueUrl: issue.html_url };
}

export interface DeleteEvent {
  ref: string;
  ref_type: 'branch' | 'tag';
  sender?: { login: string };
}

/**
 * `delete` events carry no SHA, so the branch can't be restored from here. The push handler
 * restores it when GitHub also delivers a push event with `deleted: true`; this only reports
 * if the branch is still missing afterwards.
 */
export async function handleDeleteEvent(
  event: DeleteEvent,
  config: Config,
  client: GitHubClient,
  waitMs = 20_000,
): Promise<RemediationResult> {
  if (event.ref_type !== 'branch') return { actions: [] };
  const rule = ruleFor(config, event.ref);
  if (!rule || rule.allowDeletion) return { actions: [] };
  if (event.sender && config.github.bypassUsers.includes(event.sender.login)) return { actions: [] };
  await new Promise((r) => setTimeout(r, waitMs));
  if (await client.getRefSha(event.ref)) return { actions: [`'${event.ref}' already restored.`] };
  const body = [
    `Protected branch \`${event.ref}\` was deleted by ${event.sender ? '@' + event.sender.login : 'unknown user'}.`,
    '',
    'Restore it from any clone that still has it:',
    '```sh',
    `git push origin origin/${event.ref}:refs/heads/${event.ref}`,
    '```',
  ].join('\n');
  const issue = await client.createIssue(`vcs-protection: protected branch ${event.ref} deleted`, body);
  return { actions: [`Opened issue ${issue.html_url}`], issueUrl: issue.html_url };
}

export interface PrEvent {
  pull_request: PullRequest;
}

/** Post an approvals status on the PR head so reviewers can see whether merging would be kept. */
export async function handlePrEvent(event: PrEvent, config: Config, client: GitHubClient): Promise<ApprovalCheck | null> {
  const pr = event.pull_request;
  const rule = ruleFor(config, pr.base.ref);
  if (!rule) return null;
  const check = checkApprovals(summarizeReviews(await client.reviews(pr.number), pr.user?.login), rule);
  const description = check.ok
    ? `${check.description}: OK to merge`
    : `${check.description}: merging now will be reverted`;
  await client.createStatus(pr.head.sha, check.ok ? 'success' : 'failure', description, STATUS_CONTEXT);
  return check;
}

export function repoLink(client: GitHubClient): string {
  return webUrl(client.repo);
}
