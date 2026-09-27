/**
 * Pure core of the guard's history walk.
 *
 * Every guard run judges a protected branch from its current tip back to the last commit the
 * guard already accepted (marked with a `vcs-protection/accepted` status). That way a run also
 * catches commits whose own run never happened: `[skip ci]` pushes, runs GitHub cancelled in the
 * concurrency queue, or a second push that landed before the first was judged.
 *
 * No I/O here: the caller fetches the facts (commits, configs, PRs, reviews, permissions).
 */
import type { BranchRule, Config } from '../config/schema.js';
import { ruleFor } from '../rules/match.js';
import { approvalFor, type ApprovalCheck } from './approvals.js';
import type { BranchPush, PullRequest, Review } from './client.js';

export type CommitViolation = 'direct-push' | 'insufficient-approvals';

export type CommitVerdict =
  | { ok: true; reason: string; pr?: PullRequest }
  | { ok: false; kind: CommitViolation; reason: string; rule: BranchRule; pr?: PullRequest };

export interface FactCommit {
  sha: string;
  parents: string[];
  /** `.vcs-protection.json` in this commit's own tree (null: none, or invalid). */
  config: Config | null;
  /** The guard already reported this commit (status `failure`); don't open another issue for it. */
  reported: boolean;
  /** Pull requests GitHub associates with this commit. */
  prs: PullRequest[];
  /** Login of the commit's committer on GitHub (`web-flow` for merges made in the GitHub UI). */
  committer?: string | null;
}

export interface ChainFacts {
  branch: string;
  /** Unaccepted first-parent commits, newest (the tip) first. */
  commits: FactCommit[];
  /** Config at the commit below the oldest one: the last trusted state (null: before protection). */
  boundaryConfig: Config | null;
  /** Reviews of the PRs that matter, by PR number. */
  reviews: Map<number, Review[]>;
  /** Logins allowed to approve (write access). */
  eligible: Set<string>;
  /**
   * Who pushed what to this branch (the repository activity API, plus the current push event).
   * A commit is a bypass-user commit when a push by a `github.bypassUsers` login brought it in,
   * even if that push's own guard run never happened (`[skip ci]`, a cancelled run).
   */
  pushes: BranchPush[];
}

export interface ChainCommit {
  sha: string;
  parents: string[];
  reported: boolean;
  verdict: CommitVerdict;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Judge each unaccepted commit, oldest first. A commit is judged by the rules of the last
 * *verified* commit below it, and only a verified commit can change the rules: an unreviewed
 * commit that relaxes the config can't loosen the check for the commits on top of it.
 */
export function judgeChain(f: ChainFacts): ChainCommit[] {
  const chainIndex = new Map(f.commits.map((c, i) => [c.sha, i])); // smaller index = newer
  /** The pusher who brought commit `index` onto the branch, when a known push covers it. */
  const pushedBy = (index: number): string[] =>
    f.pushes
      .filter((p) => {
        const top = chainIndex.get(p.after);
        if (top === undefined || top > index) return false;
        const bottom = chainIndex.get(p.before); // undefined: `before` is below the chain
        return bottom === undefined || index < bottom;
      })
      .map((p) => p.actor ?? '')
      .filter(Boolean);
  const approvalCache = new Map<number, ApprovalCheck>();
  const approval = (pr: PullRequest, rule: BranchRule, config: Config) => {
    let check = approvalCache.get(pr.number);
    if (!check) {
      check = approvalFor(pr, f.reviews.get(pr.number) ?? [], rule, {
        eligible: (login) => f.eligible.has(login),
        dismissStaleApprovals: config.github.dismissStaleApprovals,
      });
      approvalCache.set(pr.number, check);
    }
    return check;
  };

  let rules = f.boundaryConfig;
  const out: ChainCommit[] = [];
  for (let i = f.commits.length - 1; i >= 0; i--) {
    const c = f.commits[i]!;
    const verdict = judgeOne(c, i);
    out.unshift({ sha: c.sha, parents: c.parents, reported: c.reported, verdict });
    if (verdict.ok) rules = c.config;
  }
  return out;

  function judgeOne(c: FactCommit, index: number): CommitVerdict {
    if (!rules) return { ok: true, reason: 'before branch protection was set up' };
    const rule = ruleFor(rules, f.branch);
    if (!rule) return { ok: true, reason: `'${f.branch}' was not protected at that point` };
    const bypasser = pushedBy(index).find((login) => rules!.github.bypassUsers.includes(login));
    if (bypasser) return { ok: true, reason: `${bypasser} is in github.bypassUsers` };

    const merged = c.prs.filter((p) => p.merged_at && p.base.ref === f.branch);
    // Merge or squash commit of a PR.
    const own = merged.find((p) => p.merge_commit_sha === c.sha);
    // A commit of a rebase-merged PR: the PR's last commit is further up this chain.
    const rebased = own
      ? undefined
      : merged.find((p) => {
          const at = p.merge_commit_sha ? chainIndex.get(p.merge_commit_sha) : undefined;
          return at !== undefined && at < index;
        });
    const pr = own ?? rebased;
    if (!pr) {
      return {
        ok: false,
        kind: 'direct-push',
        reason: `Commit ${short(c.sha)} was pushed directly to '${f.branch}' instead of being merged from a pull request.`,
        rule,
      };
    }
    const check = approval(pr, rule, rules);
    if (!check.ok) {
      return {
        ok: false,
        kind: 'insufficient-approvals',
        reason: `Pull request #${pr.number} was merged into '${f.branch}' without the required approvals (${check.description}).`,
        rule,
        pr,
      };
    }
    return { ok: true, reason: `merged from PR #${pr.number} (${check.description})`, pr };
  }
}

/**
 * The rules in force after the chain: those of the newest verified commit, or the anchor's if no
 * commit was verified. Only verified commits can change them.
 */
export function finalRules(chain: ChainCommit[], commits: FactCommit[], boundaryConfig: Config | null): Config | null {
  const newestOk = chain.findIndex((c) => c.verdict.ok);
  return newestOk === -1 ? boundaryConfig : (commits[newestOk]?.config ?? null);
}

export interface RemediationPlan {
  violations: ChainCommit[];
  /** Violations that haven't been reported yet: an issue is opened only for these. */
  newViolations: ChainCommit[];
  /** Move the branch here (first parent of the oldest violation); null: report only. */
  resetTo: string | null;
  /** Why there is no reset, when there are violations. */
  noResetReason?: string;
  /** Verified commits that stay on the branch: mark them accepted. */
  accept: string[];
}

/**
 * Decide what to do about a judged chain. The branch is reset only when every commit from the
 * oldest violation up to the tip is a violation: a reviewed merge that landed on top is never
 * thrown away. Otherwise the violations are reported, with instructions to revert them.
 */
export function planRemediation(chain: ChainCommit[], enforcement: 'revert' | 'report'): RemediationPlan {
  const violations = chain.filter((c) => !c.verdict.ok);
  const newViolations = violations.filter((c) => !c.reported);
  let oldest = -1;
  chain.forEach((c, i) => {
    if (!c.verdict.ok) oldest = i;
  });
  let resetTo: string | null = null;
  let noResetReason: string | undefined;
  if (oldest >= 0) {
    const tail = chain.slice(0, oldest + 1);
    if (enforcement !== 'revert') noResetReason = 'enforcement is "report"';
    else if (!tail.every((c) => !c.verdict.ok)) noResetReason = 'reviewed changes were merged on top of it';
    else if (!chain[oldest]!.parents[0]) noResetReason = 'it is the first commit of the branch';
    else resetTo = chain[oldest]!.parents[0]!;
  }
  const staying = resetTo ? chain.slice(oldest + 1) : chain;
  return {
    violations,
    newViolations,
    resetTo,
    noResetReason,
    accept: staying.filter((c) => c.verdict.ok).map((c) => c.sha),
  };
}
