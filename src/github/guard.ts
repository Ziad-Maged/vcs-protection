import type { BranchRule, Config } from '../config/schema.js';
import { ruleFor } from '../rules/match.js';
import { GitHubError, type CheckRun, type GitHubClient, type PullRequest, type Review, type WorkflowRun } from './client.js';
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

export type ViolationKind = 'direct-push' | 'force-push' | 'insufficient-approvals' | 'deleted' | 'created' | 'poison-pill';

export type Verdict =
  | { ok: true; reason: string; pr?: PullRequest }
  | {
      ok: false;
      kind: ViolationKind;
      reason: string;
      branch: string;
      rule: BranchRule;
      pr?: PullRequest;
      /** Extra lines for the issue (e.g. the failing checks). */
      details?: string[];
      /** How to undo the commit by hand when the branch could not be reset (poison pill). */
      revertCommand?: string;
    };

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
  let reset = false;

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
        reset = true;
      } else {
        await client.updateRef(branch, event.before, true);
        actions.push(`Reset '${branch}' back to ${short(event.before)}.`);
        reset = true;
      }
    }
  } else {
    actions.push('Enforcement is "report": nothing was reverted.');
  }

  const repo = client.repo;
  const who = event.sender?.login ? `@${event.sender.login}` : 'unknown user';
  const poison = verdict.kind === 'poison-pill';
  const lines = [
    poison
      ? `**vcs-protection** detected that a change merged into protected branch \`${branch}\` broke a critical CI workflow (poison pill).`
      : `**vcs-protection** detected a change to protected branch \`${branch}\` that did not come through an approved pull request.`,
    '',
    `- **Who:** ${who}`,
    `- **What:** ${verdict.reason}`,
    ...(verdict.details ?? []).map((d) => `  - ${d}`),
    poison
      ? `- **Rule:** \`${verdict.rule.pattern}\` must keep the critical workflows (${config.github.poisonPill.workflows.join(', ')}) passing`
      : `- **Rule:** \`${verdict.rule.pattern}\` requires ${verdict.rule.requiredApprovals} approval(s) from someone other than the PR author`,
    `- **Before:** \`${event.before}\``,
    `- **After:** \`${event.after}\``,
    ...(verdict.pr ? [`- **Pull request:** ${verdict.pr.html_url}`] : []),
    '',
    '### Actions taken',
    ...actions.map((a) => `- ${a}`),
  ];
  if (poison && !reset && verdict.revertCommand) {
    const fix = `vcs-protection/revert-${short(event.after)}`;
    lines.push(
      '',
      `### Undo it through a pull request`,
      `\`${branch}\` was not reset${revert ? ' because newer commits landed on top of it' : ''}. Revert the commit on a branch and get the revert approved:`,
      '```sh',
      `git fetch origin && git switch -c ${fix} origin/${branch}`,
      verdict.revertCommand,
      `git push -u origin ${fix}`,
      '```',
      `Then open the pull request: ${compareUrl(repo, branch, fix)}`,
    );
  }
  if (rescue && (!poison || reset)) {
    lines.push(
      '',
      '### How to get these changes in properly',
      poison
        ? `Fix the failing checks on a branch made from the rescue branch, then open a pull request and get it approved: ${compareUrl(repo, branch, rescue)}`
        : `Open a pull request from the rescue branch and get it approved: ${compareUrl(repo, branch, rescue)}`,
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

export interface WorkflowRunEvent {
  workflow_run: WorkflowRun;
  sender?: { login: string };
}

/** What the poison-pill decision needs to know about the repository (fetched by the caller). */
export interface PoisonPillFacts {
  /** Check runs on the run's head commit (GET /commits/{sha}/check-runs). */
  checkRuns: CheckRun[];
  /** Whether the head commit is still reachable from the branch tip (false once it was reset away). */
  stillOnBranch: boolean;
  /**
   * Check runs on the commit's first parent. A check that already failed there was inherited, not
   * caused by this commit (e.g. an innocent PR merged on top of a broken one while CI was running).
   */
  parentCheckRuns: CheckRun[];
  /** First parent of the head commit (for messages). */
  parentSha?: string;
}

type Precheck = { ok: true; verdict: Verdict } | { ok: false; branch: string; rule: BranchRule };

/** Config-only part of the poison-pill decision: is this completed run one we should judge at all? */
export function poisonPillPrecheck(run: WorkflowRun, config: Config): Precheck {
  const pill = config.github.poisonPill;
  const skip = (reason: string): Precheck => ({ ok: true, verdict: { ok: true, reason } });
  if (!pill.enabled) return skip('poison pill is disabled');
  if (run.event !== 'push') return skip(`run was triggered by '${run.event}', not by a push`);
  const branch = run.head_branch;
  const rule = branch ? ruleFor(config, branch) : null;
  if (!branch || !rule) return skip(`'${branch ?? '(no branch)'}' is not protected`);
  if (!pill.workflows.includes(run.name)) return skip(`'${run.name}' is not a critical workflow`);
  return { ok: false, branch, rule };
}

/**
 * Poison pill: decide whether a completed critical workflow broke a protected branch.
 *
 * Pure: all repository state comes in through `facts`. Only the completed check runs of this
 * workflow run's check suite are considered (optionally narrowed to `poisonPill.checks`), so each
 * critical workflow is judged by its own jobs when it finishes.
 */
export function evaluatePoisonPill(run: WorkflowRun, config: Config, facts: PoisonPillFacts): Verdict {
  const pre = poisonPillPrecheck(run, config);
  if (pre.ok) return pre.verdict;
  const { branch, rule } = pre;
  const pill = config.github.poisonPill;
  if (!facts.stillOnBranch) return { ok: true, reason: `${short(run.head_sha)} is no longer on '${branch}' (already remediated)` };

  const breach = new Set<string>(pill.conclusions);
  const failing = facts.checkRuns.filter(
    (c) =>
      c.check_suite?.id === run.check_suite_id &&
      (pill.checks.length === 0 || pill.checks.includes(c.name)) &&
      c.status === 'completed' &&
      c.conclusion !== null &&
      breach.has(c.conclusion),
  );
  if (failing.length === 0) return { ok: true, reason: `critical checks of '${run.name}' passed on ${short(run.head_sha)}` };

  const failedBefore = new Set(
    facts.parentCheckRuns
      .filter((c) => c.status === 'completed' && c.conclusion !== null && breach.has(c.conclusion))
      .map((c) => c.name),
  );
  const inherited = failing.filter((c) => failedBefore.has(c.name));
  if (inherited.length === failing.length) {
    const parent = facts.parentSha ? short(facts.parentSha) : 'its parent';
    return {
      ok: true,
      reason: `${inherited.map((c) => c.name).join(', ')} already failed on ${parent}; not caused by ${short(run.head_sha)}`,
    };
  }

  return {
    ok: false,
    kind: 'poison-pill',
    reason: `Critical checks failed on '${branch}' after ${short(run.head_sha)} was merged: ${failing.map((c) => c.name).join(', ')}.`,
    branch,
    rule,
    details: [
      ...failing.map((c) => `\`${c.name}\`: ${c.conclusion} (${c.html_url})`),
      `Workflow run '${run.name}': ${run.html_url}`,
    ],
  };
}

/**
 * Gather the facts for `evaluatePoisonPill` from the API and, on a breach, describe the offending
 * commit as a push (before = its first parent) so `remediatePush` can handle it.
 */
export async function judgeWorkflowRun(
  event: WorkflowRunEvent,
  config: Config,
  client: GitHubClient,
): Promise<{ verdict: Verdict; push?: PushEvent }> {
  const run = event.workflow_run;
  const pre = poisonPillPrecheck(run, config);
  if (pre.ok) return { verdict: pre.verdict };

  const sha = run.head_sha;
  const tip = await client.getRefSha(pre.branch);
  let stillOnBranch = false;
  if (tip === sha) stillOnBranch = true;
  else if (tip) {
    const cmp = await client.compare(sha, tip);
    stillOnBranch = cmp.status === 'ahead' || cmp.status === 'identical';
  }
  const commit = await client.getCommit(sha);
  const parent = commit.parents[0]?.sha;
  if (!parent) return { verdict: { ok: true, reason: `${short(sha)} has no parent to go back to` } };
  const verdict = evaluatePoisonPill(run, config, {
    checkRuns: await client.checkRunsForCommit(sha),
    stillOnBranch,
    parentCheckRuns: await client.checkRunsForCommit(parent),
    parentSha: parent,
  });
  if (verdict.ok) return { verdict };
  verdict.revertCommand = commit.parents.length > 1 ? `git revert -m 1 ${sha}` : `git revert ${sha}`;
  const prs = await client.pullsForCommit(sha);
  verdict.pr = prs.find((p) => p.merged_at && p.base.ref === pre.branch);

  const push: PushEvent = {
    ref: `refs/heads/${pre.branch}`,
    before: parent,
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    sender: event.sender,
  };
  return { verdict, push };
}
