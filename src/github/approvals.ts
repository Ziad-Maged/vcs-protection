import type { BranchRule } from '../config/schema.js';
import type { PullRequest, Review } from './client.js';

export interface ApprovalSummary {
  approvedBy: string[];
  changesRequestedBy: string[];
}

export interface ReviewFilter {
  /** Whether a reviewer may approve here (write access). Omitted: everyone counts. */
  eligible?: (login: string) => boolean;
  /** With `dismissStaleApprovals`: only reviews of this commit (the PR's final head) count. */
  headSha?: string;
}

/**
 * Latest decisive review state per reviewer. COMMENTED/PENDING reviews don't change a
 * reviewer's standing, DISMISSED clears it, and the PR author never counts. Reviewers who
 * can't approve (no write access) and, optionally, reviews of older commits are ignored.
 */
export function summarizeReviews(reviews: Review[], author: string | undefined, filter: ReviewFilter = {}): ApprovalSummary {
  const latest = new Map<string, Review['state']>();
  const ordered = [...reviews].sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '') || a.id - b.id);
  for (const r of ordered) {
    const login = r.user?.login;
    if (!login || login === author) continue;
    if (filter.eligible && !filter.eligible(login)) continue;
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    // Stale approvals don't count (like GitHub's "dismiss stale approvals"); change requests still do.
    if (filter.headSha && r.state === 'APPROVED' && r.commit_id !== filter.headSha) continue;
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

/** Pure approval check of a PR, given its reviews and who may approve. */
export function approvalFor(
  pr: PullRequest,
  reviews: Review[],
  rule: BranchRule,
  opts: { eligible?: (login: string) => boolean; dismissStaleApprovals?: boolean },
): ApprovalCheck {
  const filter: ReviewFilter = { eligible: opts.eligible, headSha: opts.dismissStaleApprovals ? pr.head.sha : undefined };
  return checkApprovals(summarizeReviews(reviews, pr.user?.login, filter), rule);
}
