import { CONFIG_FILE, parseConfig, type BranchRule, type Config } from '../config/schema.js';
import { ruleFor } from '../rules/match.js';
import { approvalFor, type ApprovalCheck } from './approvals.js';
import { GitHubError, type CheckRun, type CommitStatus, type GitHubClient, type PullRequest, type Review, type WorkflowRun } from './client.js';
import { compareUrl, webUrl } from './remote.js';
import { finalRules, judgeChain, planRemediation, type ChainCommit, type FactCommit } from './walk.js';

export { checkApprovals, summarizeReviews, type ApprovalCheck, type ApprovalSummary } from './approvals.js';

export const STATUS_CONTEXT = 'vcs-protection/approvals';
/** Prefix of the per-branch commit status the guard puts on commits it has verified. */
export const ACCEPTED_CONTEXT = 'vcs-protection/accepted';
/** The marker context for one branch: a commit verified for `develop` is not verified for `main`. */
export const acceptedContext = (branch: string) => `${ACCEPTED_CONTEXT}/${branch}`;
/** Status the guard puts on a commit whose poison pill it has already reported. */
export const POISON_CONTEXT = 'vcs-protection/poison-pill';
/** Account the guard's statuses come from unless the workflow says otherwise. */
export const DEFAULT_GUARD_LOGIN = 'github-actions[bot]';
/** How far back (first-parent commits) one run walks looking for the last accepted commit. */
export const MAX_WALK = 100;

const isZero = (sha: string) => /^0+$/.test(sha);
const short = (sha: string) => sha.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Approvals (I/O around the pure helpers in approvals.ts)
// ---------------------------------------------------------------------------------------------

/** Reviews of a PR, and which of the reviewers may approve (write access). */
async function reviewFacts(client: GitHubClient, pr: PullRequest): Promise<{ reviews: Review[]; eligible: Set<string> }> {
  const reviews = await client.reviews(pr.number);
  const eligible = new Set<string>();
  for (const login of new Set(reviews.map((r) => r.user?.login).filter((l): l is string => !!l))) {
    if (await client.canApprove(login)) eligible.add(login);
  }
  return { reviews, eligible };
}

export async function approvalCheckFor(pr: PullRequest, rule: BranchRule, config: Config, client: GitHubClient): Promise<ApprovalCheck> {
  const { reviews, eligible } = await reviewFacts(client, pr);
  return approvalFor(pr, reviews, rule, {
    eligible: (l) => eligible.has(l),
    dismissStaleApprovals: config.github.dismissStaleApprovals,
  });
}

// ---------------------------------------------------------------------------------------------
// Accepted / reported markers
// ---------------------------------------------------------------------------------------------

/** The latest status of `context` on a commit posted by the guard account (statuses come newest first). */
function guardStatus(statuses: CommitStatus[], context: string, guardLogin: string): CommitStatus | undefined {
  return statuses.find((s) => s.context === context && s.creator?.login === guardLogin);
}

/** The guard's own marker for `branch` on a commit. */
export function markerState(statuses: CommitStatus[], branch: string, guardLogin: string): 'accepted' | 'reported' | null {
  const mine = guardStatus(statuses, acceptedContext(branch), guardLogin);
  if (mine?.state === 'success') return 'accepted';
  if (mine?.state === 'failure') return 'reported';
  return null;
}

async function mark(
  client: GitHubClient,
  branch: string,
  shas: string[],
  state: 'success' | 'failure',
  description: string,
): Promise<void> {
  for (const sha of shas) await client.createStatus(sha, state, description, acceptedContext(branch));
}

/**
 * The rules the guard may trust for `branch`: the config in the newest commit, walking first
 * parents from `fromSha`, that carries the guard's accepted marker for that branch. Never the
 * config of an unverified commit. Null when no verified commit is found (not set up yet).
 */
export async function trustedConfigFor(
  client: GitHubClient,
  branch: string,
  fromSha: string | null,
  guardLogin: string,
): Promise<{ config: Config | null; anchor: string } | null> {
  let sha: string | undefined = fromSha && !isZero(fromSha) ? fromSha : undefined;
  for (let i = 0; sha && i <= MAX_WALK; i++) {
    if (markerState(await client.statuses(sha), branch, guardLogin) === 'accepted') {
      return { config: await configAt(client, sha), anchor: sha };
    }
    sha = (await client.getCommit(sha)).parents[0]?.sha;
  }
  return null;
}

async function configAt(client: GitHubClient, ref: string): Promise<Config | null> {
  const raw = await client.fileAt(CONFIG_FILE, ref);
  if (raw === null) return null;
  try {
    return parseConfig(raw, `${CONFIG_FILE}@${short(ref)}`);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Push events: the checks that need the event itself (deletion, creation, force push)
// ---------------------------------------------------------------------------------------------

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
      /** How to undo the commit by hand when the branch is not reset (poison pill). */
      revertCommand?: string;
      /** False: never reset for this verdict, only report (e.g. the poison pill can't tell who broke it). */
      resetAllowed?: boolean;
    };

/**
 * Judge what only the push event can tell: a deleted, created or force-pushed protected branch.
 * Ordinary pushes return ok here; their commits are judged by the history walk (`guardBranch`).
 */
export async function judgePush(
  event: PushEvent,
  config: Config,
  client: GitHubClient,
  guardLogin = DEFAULT_GUARD_LOGIN,
): Promise<Verdict> {
  if (!event.ref.startsWith('refs/heads/')) return { ok: true, reason: 'not a branch' };
  const branch = event.ref.slice('refs/heads/'.length);
  const rule = ruleFor(config, branch);
  if (!rule) return { ok: true, reason: `'${branch}' is not protected` };
  const sender = event.sender?.login;
  if (sender && config.github.bypassUsers.includes(sender) && (event.deleted || event.created || event.forced)) {
    return { ok: true, reason: `${sender} is in github.bypassUsers` };
  }

  if (event.deleted) {
    if (rule.allowDeletion) return { ok: true, reason: 'deletion allowed by rule' };
    return { ok: false, kind: 'deleted', reason: `Protected branch '${branch}' was deleted.`, branch, rule };
  }

  if (event.created) {
    const base = event.repository?.default_branch;
    if (!base || base === branch) return { ok: true, reason: 'initial branch' };
    // Restoring a deleted protected branch at a commit the guard had already verified.
    if (markerState(await client.statuses(event.after), branch, guardLogin) === 'accepted') {
      return { ok: true, reason: `re-created at verified commit ${short(event.after)}` };
    }
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
  return { ok: true, reason: 'regular push' };
}

export interface RemediationResult {
  actions: string[];
  issueUrl?: string;
}

/**
 * Save `sha` on a rescue branch. Returns false (and says why) if the branch can't be created and
 * doesn't already hold that commit: the caller must then not reset, or the commits could be lost.
 */
async function saveRescue(client: GitHubClient, rescue: string, sha: string, actions: string[]): Promise<boolean> {
  try {
    await client.createRef(rescue, sha);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 422)) throw err;
    const existing = await client.getRefSha(rescue);
    if (existing !== sha) {
      actions.push(`Could NOT save the pushed commits on '${rescue}' (${err.message.slice(0, 120)}), so nothing was reset.`);
      return false;
    }
  }
  actions.push(`Saved the pushed commits on branch '${rescue}'.`);
  return true;
}

/** Atomically move `branch` from `expected` to `target` (null: delete). */
async function moveBranch(
  client: GitHubClient,
  branch: string,
  expected: string,
  target: string | null,
  actions: string[],
): Promise<boolean> {
  const res = await client.updateRefAtomic(branch, expected, target);
  if (!res.ok) {
    const now = await client.getRefSha(branch);
    actions.push(`Did NOT move '${branch}': it changed again (now ${now ? short(now) : 'deleted'}). The next guard run re-checks it.`);
    return false;
  }
  if (res.note) actions.push(res.note);
  return true;
}

function revertCommand(sha: string, parents: number): string {
  return parents > 1 ? `git revert -m 1 ${sha}` : `git revert ${sha}`;
}

/** Undo a landed change: one commit, or the whole range of a rebase merge. */
function revertLanded(sha: string, parents: number, before: string, count: number): string {
  return count > 1 ? `git revert --no-edit ${before}..${sha}` : revertCommand(sha, parents);
}

/** Issues can be turned off for a repository: the violation is then reported in the job log only. */
const issuesDisabled = (err: unknown) => err instanceof GitHubError && (err.status === 410 || err.status === 404);

/** Remediate one event-level violation (deletion, creation, force push, poison pill). */
export async function remediatePush(
  event: PushEvent,
  verdict: Extract<Verdict, { ok: false }>,
  config: Config,
  client: GitHubClient,
): Promise<RemediationResult> {
  const { branch } = verdict;
  const actions: string[] = [];
  const revert = config.github.enforcement === 'revert';
  const mayReset = revert && verdict.resetAllowed !== false;
  let rescue: string | null = null;
  let reset = false;

  if (mayReset) {
    if (verdict.kind === 'deleted') {
      await client.createRef(branch, event.before);
      actions.push(`Restored '${branch}' at ${short(event.before)}.`);
    } else {
      rescue = `${config.github.rescueBranchPrefix}${branch}-${short(event.after)}`;
      if (!(await saveRescue(client, rescue, event.after, actions))) {
        rescue = null;
      } else if (verdict.kind === 'created' || isZero(event.before)) {
        reset = await moveBranch(client, branch, event.after, null, actions);
        if (reset) actions.push(`Deleted '${branch}', which was created from unreviewed commits.`);
      } else {
        reset = await moveBranch(client, branch, event.after, event.before, actions);
        if (reset) actions.push(`Reset '${branch}' back to ${short(event.before)}.`);
      }
    }
  } else if (!revert) {
    actions.push('Enforcement is "report": nothing was reverted.');
  } else {
    actions.push(`Nothing was reset: ${verdict.details?.length ? 'see the details above' : 'the cause is not certain'}.`);
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
      : `- **Rule:** \`${verdict.rule.pattern}\` requires ${verdict.rule.requiredApprovals} approval(s) from someone with write access, other than the PR author`,
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
      `\`${branch}\` was not reset. Revert the commit on a branch and get the revert approved:`,
      '```sh',
      `git fetch origin && git switch -c ${fix} origin/${branch}`,
      verdict.revertCommand,
      `git push -u origin ${fix}`,
      '```',
      `Then open the pull request: ${compareUrl(repo, branch, fix)}`,
      ...(rescue ? ['', `A copy of the broken state is on \`${rescue}\`.`] : []),
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
  let issueUrl: string | undefined;
  try {
    const issue = await client.createIssue(`vcs-protection: ${verdict.kind} on ${branch} (${short(event.after)})`, lines.join('\n'));
    issueUrl = issue.html_url;
    actions.push(`Opened issue ${issue.html_url}`);
  } catch (err) {
    if (!issuesDisabled(err)) throw err;
    actions.push('Could not open an issue (issues are disabled); the details are in this log:', ...lines);
  }
  // Remember it, so re-runs of the failed CI (or another critical workflow) don't report it again.
  if (poison) await client.createStatus(event.after, 'failure', issueUrl ? `reported: ${issueUrl}` : 'reported in the job log', POISON_CONTEXT);
  return { actions, issueUrl };
}

// ---------------------------------------------------------------------------------------------
// The history walk
// ---------------------------------------------------------------------------------------------

export interface PushInfo {
  sender?: string;
  before: string;
  after: string;
}

/** Delays between retries when GitHub hasn't linked a fresh merge commit to its PR yet. */
export const PR_LOOKUP_RETRIES_MS = [2_000, 5_000, 10_000];
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The facts `judgeChain` needs for a list of commits (newest first). Shared with `audit`. */
export async function gatherChainFacts(
  client: GitHubClient,
  branch: string,
  commits: Omit<FactCommit, 'prs'>[],
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ commits: FactCommit[]; reviews: Map<number, Review[]>; eligible: Set<string> }> {
  const sleep = opts.sleep ?? sleepMs;
  const withPrs: FactCommit[] = [];
  for (const c of commits) {
    let prs = await client.pullsForCommit(c.sha);
    // A merge made in the GitHub UI (committer web-flow) can take a few seconds to be linked to
    // its PR. Judging it before that would reset a legitimate merge.
    if (prs.length === 0 && c.committer === 'web-flow') {
      for (const ms of PR_LOOKUP_RETRIES_MS) {
        await sleep(ms);
        prs = await client.pullsForCommit(c.sha);
        if (prs.length) break;
      }
    }
    withPrs.push({ ...c, prs });
  }
  const reviews = new Map<number, Review[]>();
  const eligible = new Set<string>();
  for (const c of withPrs) {
    for (const pr of c.prs) {
      if (!pr.merged_at || pr.base.ref !== branch || reviews.has(pr.number)) continue;
      const facts = await reviewFacts(client, pr);
      reviews.set(pr.number, facts.reviews);
      for (const l of facts.eligible) eligible.add(l);
    }
  }
  return { commits: withPrs, reviews, eligible };
}

export interface GuardResult {
  lines: string[];
  violations: number;
  issueUrl?: string;
  /** The walk found no verified commit and this isn't the push that introduced the rules. */
  uninitialised?: boolean;
  /** The branch was moved back. */
  reset?: boolean;
  /** The rules in force after this run: those of the newest verified commit (null: none). */
  trustedConfig: Config | null;
}

export const baselineHint = (branch: string) =>
  `No verified commit on '${branch}' in the last ${MAX_WALK} commits: run the guard once with baseline ` +
  `(Actions → vcs-protection guard → Run workflow → baseline).`;

/**
 * Judge `branch` from its current tip back to the last commit the guard verified *for this
 * branch*, then accept, report or reset. Called for every push (after the event checks) and for
 * every protected branch by the sweep.
 *
 * Trust comes only from the guard's own markers: the walk stops at a marked commit (or the root)
 * and the rules are the ones in that commit, changed only by commits verified on the way up.
 * `guardLogin` must come from the workflow, never from the commits being judged.
 */
export async function guardBranch(
  branch: string,
  client: GitHubClient,
  opts: { guardLogin: string; push?: PushInfo; sleep?: (ms: number) => Promise<void> },
): Promise<GuardResult> {
  const { guardLogin, push } = opts;
  const tip = await client.getRefSha(branch);
  if (!tip) return { lines: [`'${branch}' does not exist.`], violations: 0, trustedConfig: null };

  // Walk back until this branch's accepted marker, the root commit, or the limit.
  const raw: Omit<FactCommit, 'prs'>[] = [];
  let anchor: string | null = null;
  let sha: string | undefined = tip;
  while (sha && raw.length < MAX_WALK) {
    const state = markerState(await client.statuses(sha), branch, guardLogin);
    if (state === 'accepted') {
      anchor = sha;
      break;
    }
    const commit = await client.getCommit(sha);
    raw.push({
      sha,
      parents: commit.parents.map((p) => p.sha),
      config: await configAt(client, sha),
      reported: state === 'reported',
      committer: commit.committer?.login ?? null,
    });
    sha = commit.parents[0]?.sha;
  }
  if (anchor && raw.length === 0) {
    return { lines: [`✅ ${branch}: ${short(tip)} is verified.`], violations: 0, trustedConfig: await configAt(client, anchor) };
  }

  if (!anchor) {
    // Never verified. The one automatic start: the push that introduces the rules on this branch.
    const introduced =
      push && push.after === tip && raw[0]?.config && !(isZero(push.before) ? null : await configAt(client, push.before));
    if (introduced) {
      await mark(client, branch, [tip], 'success', 'baseline: this push introduced the rules');
      return {
        lines: [`✅ ${branch}: baseline set at ${short(tip)} (this push introduced ${CONFIG_FILE}).`],
        violations: 0,
        trustedConfig: raw[0]!.config,
      };
    }
    return { lines: [`❌ ${baselineHint(branch)}`], violations: 0, uninitialised: true, trustedConfig: null };
  }

  const boundaryConfig = await configAt(client, anchor);
  const pushes = await client.branchPushes(branch);
  if (push?.sender) pushes.push({ before: push.before, after: push.after, actor: push.sender });
  const facts = await gatherChainFacts(client, branch, raw, { sleep: opts.sleep });
  const chain = judgeChain({ branch, boundaryConfig, pushes, ...facts });
  const trustedConfig = finalRules(chain, facts.commits, boundaryConfig);
  const settings = boundaryConfig ?? trustedConfig;
  const lines = chain.map((c) => `${c.verdict.ok ? '✅' : '❌'} ${branch} ${short(c.sha)}: ${c.verdict.reason}`);
  if (!settings) {
    await mark(client, branch, chain.map((c) => c.sha).slice(0, 1), 'success', 'verified by vcs-protection (no rules)');
    return { lines, violations: 0, trustedConfig };
  }
  const plan = planRemediation(chain, settings.github.enforcement);

  const actions: string[] = [];
  let resetDone = false;
  let rescue: string | null = null;
  if (plan.resetTo) {
    rescue = `${settings.github.rescueBranchPrefix}${branch}-${short(tip)}`;
    if (await saveRescue(client, rescue, tip, actions)) {
      resetDone = await moveBranch(client, branch, tip, plan.resetTo, actions);
      if (resetDone) actions.push(`Reset '${branch}' back to ${short(plan.resetTo)}.`);
    } else {
      rescue = null;
    }
  } else if (plan.violations.length && plan.noResetReason) {
    actions.push(`Did not reset '${branch}': ${plan.noResetReason}.`);
  }

  // Another run (the sweep and a push run can overlap) may have reported them meanwhile.
  const fresh: ChainCommit[] = [];
  for (const c of plan.newViolations) {
    if (markerState(await client.statuses(c.sha), branch, guardLogin) !== 'reported') fresh.push(c);
  }

  // Open the issue first, and only then write the markers: a failed issue must not leave the
  // violation marked as reported (it would never be reported again).
  let issueUrl: string | undefined;
  let reportedAs = 'reported by vcs-protection';
  if (fresh.length || resetDone) {
    const body = chainIssue(client, branch, tip, plan.violations, actions, rescue, resetDone, settings, push);
    try {
      const issue = await client.createIssue(`vcs-protection: ${body.kind} on ${branch} (${short(body.sha)})`, body.text);
      issueUrl = issue.html_url;
      reportedAs = `reported: ${issue.html_url}`;
      actions.push(`Opened issue ${issue.html_url}`);
    } catch (err) {
      if (!issuesDisabled(err)) throw err;
      reportedAs = 'reported in the job log (issues disabled)';
      actions.push('Could not open an issue (issues are disabled); the details are in this log:', body.text);
    }
  }

  await mark(client, branch, plan.accept, 'success', 'verified by vcs-protection');
  if (!resetDone) await mark(client, branch, fresh.map((c) => c.sha), 'failure', reportedAs.slice(0, 140));

  lines.push(...actions.map((a) => `- ${a}`));
  return { lines, violations: plan.violations.length, issueUrl, reset: resetDone, trustedConfig };
}

/** Mark the current tip of `branch` as verified, on an explicit request (Run workflow → baseline). */
export async function baselineBranch(client: GitHubClient, branch: string, actor: string | undefined): Promise<string> {
  const tip = await client.getRefSha(branch);
  if (!tip) return `'${branch}' does not exist.`;
  await mark(client, branch, [tip], 'success', `baseline by @${actor ?? 'unknown'}`);
  return `✅ Baseline set on ${branch} at ${short(tip)}.`;
}

/** Mark a newly created protected branch's tip as verified, so later walks have an anchor. */
export async function acceptCreatedBranch(client: GitHubClient, branch: string, sha: string, reason: string): Promise<void> {
  await mark(client, branch, [sha], 'success', reason.slice(0, 140));
}

function chainIssue(
  client: GitHubClient,
  branch: string,
  tip: string,
  violations: ChainCommit[],
  actions: string[],
  rescue: string | null,
  resetDone: boolean,
  config: Config,
  push?: PushInfo,
): { kind: string; sha: string; text: string } {
  const repo = client.repo;
  const first = violations[0]!;
  const kind = first.verdict.ok ? 'direct-push' : first.verdict.kind;
  const rule = first.verdict.ok ? ruleFor(config, branch) : first.verdict.rule;
  const lines = [
    `**vcs-protection** found commits on protected branch \`${branch}\` that did not come through an approved pull request.`,
    '',
    ...(push?.sender ? [`- **Latest push by:** @${push.sender}`] : []),
    ...(rule ? [`- **Rule:** \`${rule.pattern}\` requires ${rule.requiredApprovals} approval(s) from someone with write access, other than the PR author`] : []),
    `- **Tip:** \`${tip}\``,
    '',
    '### Commits',
    ...violations.map((c) => {
      const v = c.verdict as Extract<ChainCommit['verdict'], { ok: false }>;
      return `- \`${short(c.sha)}\` ${v.kind}: ${v.reason}${v.pr ? ` (${v.pr.html_url})` : ''}${c.reported ? ' (already reported)' : ''}`;
    }),
    '',
    '### Actions taken',
    ...actions.map((a) => `- ${a}`),
  ];
  if (resetDone && rescue) {
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
  } else {
    const fix = `vcs-protection/revert-${short(tip)}`;
    lines.push(
      '',
      '### Undo them through a pull request',
      `Revert the commits on a branch (newest first) and get the revert approved:`,
      '```sh',
      `git fetch origin && git switch -c ${fix} origin/${branch}`,
      ...violations.map((c) => revertCommand(c.sha, c.parents.length)),
      `git push -u origin ${fix}`,
      '```',
      `Then open the pull request: ${compareUrl(repo, branch, fix)}`,
    );
  }
  return { kind, sha: first.sha, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------------------------
// Branch deletion
// ---------------------------------------------------------------------------------------------

export interface DeleteEvent {
  ref: string;
  ref_type: 'branch' | 'tag';
  sender?: { login: string };
}

/**
 * `delete` events carry no SHA. Restore the branch from the repository activity API (which
 * records the deleted tip); if that's unavailable, open an issue with restore instructions.
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
  await new Promise((r) => setTimeout(r, waitMs)); // a push-triggered run may restore it first
  if (await client.getRefSha(event.ref)) return { actions: [`'${event.ref}' already restored.`] };

  const who = event.sender ? '@' + event.sender.login : 'unknown user';
  const deletion = config.github.enforcement === 'revert' ? await client.lastDeletion(event.ref) : null;
  if (deletion && !isZero(deletion.before)) {
    try {
      await client.createRef(event.ref, deletion.before);
      const body = `Protected branch \`${event.ref}\` was deleted by ${who}. **vcs-protection** restored it at \`${deletion.before}\`.`;
      const issue = await client.createIssue(`vcs-protection: deleted on ${event.ref} (${short(deletion.before)})`, body);
      return { actions: [`Restored '${event.ref}' at ${short(deletion.before)}.`, `Opened issue ${issue.html_url}`], issueUrl: issue.html_url };
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 422)) throw err; // re-created meanwhile
      return { actions: [`'${event.ref}' already restored.`] };
    }
  }
  const body = [
    `Protected branch \`${event.ref}\` was deleted by ${who}.`,
    '',
    'Restore it from any clone that still has it (the bypass is needed because the local hooks protect this branch):',
    '```sh',
    `VCS_PROTECTION_BYPASS="restore ${event.ref}" git push origin origin/${event.ref}:refs/heads/${event.ref}`,
    '```',
  ].join('\n');
  const issue = await client.createIssue(`vcs-protection: protected branch ${event.ref} deleted`, body);
  return { actions: [`Opened issue ${issue.html_url}`], issueUrl: issue.html_url };
}

// ---------------------------------------------------------------------------------------------
// Pull request status
// ---------------------------------------------------------------------------------------------

export interface PrEvent {
  pull_request: PullRequest;
}

/** Post an approvals status on the PR head so reviewers can see whether merging would be kept. */
export async function handlePrEvent(event: PrEvent, config: Config, client: GitHubClient): Promise<ApprovalCheck | null> {
  const pr = event.pull_request;
  const rule = ruleFor(config, pr.base.ref);
  if (!rule) return null;
  const check = await approvalCheckFor(pr, rule, config, client);
  const description = check.ok
    ? `${check.description}: OK to merge`
    : `${check.description}: merging now will be reverted`;
  await client.createStatus(pr.head.sha, check.ok ? 'success' : 'failure', description, STATUS_CONTEXT);
  return check;
}

export function repoLink(client: GitHubClient): string {
  return webUrl(client.repo);
}

// ---------------------------------------------------------------------------------------------
// Poison pill
// ---------------------------------------------------------------------------------------------

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
  /** Check runs on the commit before the change landed (see `landedRange`). */
  parentCheckRuns: CheckRun[];
  /** Check suites of the same critical workflow on that commit (from its workflow runs). */
  parentSuiteIds: number[];
  /** The commit before the change landed (for messages). */
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

type Origin = 'inherited' | 'caused' | 'unknown';

/**
 * Poison pill: decide whether a completed critical workflow broke a protected branch.
 *
 * Pure: all repository state comes in through `facts`. Only the completed check runs of this
 * workflow run's check suite are considered (optionally narrowed to `poisonPill.checks`). Each
 * failing check is compared with the same check of the same workflow before the change landed:
 * failed there too → inherited; passed → caused by this change; missing, unfinished or
 * cancelled → unknown. Only a caused failure allows a reset.
 */
export function evaluatePoisonPill(run: WorkflowRun, config: Config, facts: PoisonPillFacts): Verdict {
  const pre = poisonPillPrecheck(run, config);
  if (pre.ok) return pre.verdict;
  const { branch, rule } = pre;
  const pill = config.github.poisonPill;
  if (!facts.stillOnBranch) return { ok: true, reason: `${short(run.head_sha)} is no longer on '${branch}' (already remediated)` };

  const breach = new Set<string>(pill.conclusions);
  const counts = (c: CheckRun) => pill.checks.length === 0 || pill.checks.includes(c.name);
  const failing = facts.checkRuns.filter(
    (c) =>
      c.check_suite?.id === run.check_suite_id &&
      counts(c) &&
      c.status === 'completed' &&
      c.conclusion !== null &&
      breach.has(c.conclusion),
  );
  if (failing.length === 0) return { ok: true, reason: `critical checks of '${run.name}' passed on ${short(run.head_sha)}` };

  const suites = new Set(facts.parentSuiteIds);
  const before = facts.parentCheckRuns.filter((c) => c.check_suite && suites.has(c.check_suite.id) && counts(c));
  const origin = (name: string): Origin => {
    const prev = before.filter((c) => c.name === name);
    if (prev.length === 0 || prev.some((c) => c.status !== 'completed' || c.conclusion === null || c.conclusion === 'cancelled')) {
      return 'unknown';
    }
    return prev.some((c) => breach.has(c.conclusion!)) ? 'inherited' : 'caused';
  };
  const origins = failing.map((c) => ({ check: c, origin: origin(c.name) }));
  const parent = facts.parentSha ? short(facts.parentSha) : 'the previous commit';
  if (origins.every((o) => o.origin === 'inherited')) {
    return { ok: true, reason: `${failing.map((c) => c.name).join(', ')} already failed on ${parent}; not caused by ${short(run.head_sha)}` };
  }
  const caused = origins.some((o) => o.origin === 'caused');

  return {
    ok: false,
    kind: 'poison-pill',
    reason: `Critical checks failed on '${branch}' after ${short(run.head_sha)} was merged: ${failing.map((c) => c.name).join(', ')}.`,
    branch,
    rule,
    resetAllowed: caused,
    details: [
      ...origins.map(
        ({ check: c, origin: o }) =>
          `\`${c.name}\`: ${c.conclusion} (${c.html_url})${o === 'inherited' ? ` (already failing on ${parent})` : o === 'unknown' ? ` (unknown on ${parent}: missing, unfinished or cancelled)` : ''}`,
      ),
      `Workflow run '${run.name}': ${run.html_url}`,
      ...(caused ? [] : [`Not reset: it is not certain that ${short(run.head_sha)} caused the failure, because the same checks on ${parent} are missing, unfinished or cancelled.`]),
    ],
  };
}

/**
 * The commits one merge brought onto the branch, ending at `sha`: a merge commit (one commit),
 * a squash merge (one commit), or a rebase merge (the PR's commits, found by walking first
 * parents that GitHub associates with the same PR). Returns the commit before them.
 */
export async function landedRange(
  client: GitHubClient,
  sha: string,
  branch: string,
): Promise<{ before: string; parents: number; count: number; pr?: PullRequest } | null> {
  const commit = await client.getCommit(sha);
  const first = commit.parents[0]?.sha;
  if (!first) return null;
  const pr = (await client.pullsForCommit(sha)).find((p) => p.merged_at && p.base.ref === branch);
  if (commit.parents.length > 1 || !pr) return { before: first, parents: commit.parents.length, count: 1, pr };

  const size = (await client.getPull(pr.number)).commits ?? 1;
  let before = first;
  let count = 1;
  for (let i = 1; i < size; i++) {
    const prs = await client.pullsForCommit(before);
    if (!prs.some((p) => p.number === pr.number)) break;
    const c = await client.getCommit(before);
    if (c.parents.length !== 1) break;
    before = c.parents[0]!.sha;
    count++;
  }
  return { before, parents: commit.parents.length, count, pr };
}

/**
 * Gather the facts for `evaluatePoisonPill` from the API and, on a breach, describe the change
 * as a push (before = the commit before it landed) so `remediatePush` can handle it.
 */
export async function judgeWorkflowRun(
  event: WorkflowRunEvent,
  config: Config,
  client: GitHubClient,
  guardLogin = DEFAULT_GUARD_LOGIN,
): Promise<{ verdict: Verdict; push?: PushEvent }> {
  const run = event.workflow_run;
  const pre = poisonPillPrecheck(run, config);
  if (pre.ok) return { verdict: pre.verdict };

  const sha = run.head_sha;
  // Already reported by an earlier run (another critical workflow, or a re-run of this one).
  if (guardStatus(await client.statuses(sha), POISON_CONTEXT, guardLogin)) {
    return { verdict: { ok: true, reason: `${short(sha)} was already reported by the poison pill` } };
  }
  const tip = await client.getRefSha(pre.branch);
  let stillOnBranch = false;
  if (tip === sha) stillOnBranch = true;
  else if (tip) {
    const cmp = await client.compare(sha, tip);
    stillOnBranch = cmp.status === 'ahead' || cmp.status === 'identical';
  }
  const range = await landedRange(client, sha, pre.branch);
  if (!range) return { verdict: { ok: true, reason: `${short(sha)} has no parent to go back to` } };
  const suites = (await client.workflowRunsFor(range.before))
    .filter((r) => r.name === run.name && r.event === 'push')
    .map((r) => r.check_suite_id);
  const verdict = evaluatePoisonPill(run, config, {
    checkRuns: await client.checkRunsForCommit(sha),
    stillOnBranch,
    parentCheckRuns: suites.length ? await client.checkRunsForCommit(range.before) : [],
    parentSuiteIds: suites,
    parentSha: range.before,
  });
  if (verdict.ok) return { verdict };
  verdict.revertCommand = revertLanded(sha, range.parents, range.before, range.count);
  verdict.pr = range.pr;

  const push: PushEvent = {
    ref: `refs/heads/${pre.branch}`,
    before: range.before,
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    sender: event.sender,
  };
  return { verdict, push };
}
