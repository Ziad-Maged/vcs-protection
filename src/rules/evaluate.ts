import type { BranchRule, Config } from '../config/schema.js';
import { branchName, ruleFor } from './match.js';

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/** Repository queries the rule engine needs. Kept abstract so the engine stays pure and testable. */
export interface RepoFacts {
  /** True if `sha` is the tip of, or an ancestor of, `refs/remotes/<remote>/<branch>`. */
  onRemoteBranch(sha: string, remote: string, branch: string): boolean;
  /** True if `sha` is reachable from the remote's default branch (e.g. origin/main). */
  onRemoteDefault(sha: string, remote: string): boolean;
  /** True if `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** Branch names are case-insensitive in this clone (`core.ignorecase`). */
  ignoreCase?: boolean;
}

export type BlockKind =
  /** New commits on top of the branch (commit, merge, cherry-pick, ...). */
  | 'advance'
  /** Branch moved somewhere that is not a descendant of where it was (reset, rebase, branch -f). */
  | 'rewrite'
  /** Branch created locally at a commit that is not on the remote. */
  | 'create'
  /** Push that updates the protected branch on the remote. */
  | 'push'
  /** Push that deletes the protected branch on the remote. */
  | 'push-delete';

export type Decision =
  | { action: 'allow'; reason: string }
  | { action: 'block'; kind: BlockKind; branch: string; rule: BranchRule; update: RefUpdate }
  | { action: 'bypass'; kind: BlockKind; branch: string; rule: BranchRule; update: RefUpdate; reason: string };

const isZero = (sha: string) => /^0+$/.test(sha);

export interface BypassInput {
  /** Value of VCS_PROTECTION_BYPASS, if set. */
  reason: string | undefined;
}

function applyBypass(
  block: Extract<Decision, { action: 'block' }>,
  config: Config,
  bypass: BypassInput,
): Decision {
  if (config.bypass.allowed && bypass.reason && bypass.reason.trim() !== '') {
    return { ...block, action: 'bypass', reason: bypass.reason.trim() };
  }
  return block;
}

/**
 * Decide whether a local ref update (from the reference-transaction hook) is allowed.
 *
 * A protected branch may only move to commits that already exist on the remote's copy of that
 * branch. That permits syncing (`pull`, `pull --rebase`, `reset --hard origin/main`, checkout of
 * a tracking branch) and forbids anything that would create local-only history on it.
 */
export function evaluateRefUpdate(
  update: RefUpdate,
  config: Config,
  facts: RepoFacts,
  bypass: BypassInput = { reason: undefined },
): Decision {
  if (!update.ref.startsWith('refs/heads/')) return { action: 'allow', reason: 'not a local branch' };
  const branch = branchName(update.ref);
  const rule = ruleFor(config, branch, { nocase: facts.ignoreCase });
  if (!rule) return { action: 'allow', reason: 'branch not protected' };
  if (isZero(update.newSha)) return { action: 'allow', reason: 'local branch deletion' };
  if (update.oldSha === update.newSha) return { action: 'allow', reason: 'no change' };

  if (facts.onRemoteBranch(update.newSha, config.remote, branch)) {
    return { action: 'allow', reason: 'commit already on remote branch' };
  }

  if (isZero(update.oldSha)) {
    if (facts.onRemoteDefault(update.newSha, config.remote)) {
      return { action: 'allow', reason: 'created from the remote default branch' };
    }
    return applyBypass({ action: 'block', kind: 'create', branch, rule, update }, config, bypass);
  }

  const kind: BlockKind = facts.isAncestor(update.oldSha, update.newSha) ? 'advance' : 'rewrite';
  return applyBypass({ action: 'block', kind, branch, rule, update }, config, bypass);
}

export interface PushUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** Decide whether one ref of a `git push` (from the pre-push hook) is allowed. */
export function evaluatePush(
  push: PushUpdate,
  remoteName: string,
  config: Config,
  bypass: BypassInput = { reason: undefined },
): Decision {
  const update: RefUpdate = { oldSha: push.remoteSha, newSha: push.localSha, ref: push.remoteRef };
  if (remoteName !== config.remote) return { action: 'allow', reason: `remote ${remoteName} is not ${config.remote}` };
  if (!push.remoteRef.startsWith('refs/heads/')) return { action: 'allow', reason: 'not a branch' };
  const branch = branchName(push.remoteRef);
  const rule = ruleFor(config, branch);
  if (!rule) return { action: 'allow', reason: 'branch not protected' };
  if (push.localSha === push.remoteSha) return { action: 'allow', reason: 'no change' };
  if (isZero(push.localSha)) {
    if (rule.allowDeletion) return { action: 'allow', reason: 'deletion allowed by rule' };
    return applyBypass({ action: 'block', kind: 'push-delete', branch, rule, update }, config, bypass);
  }
  return applyBypass({ action: 'block', kind: 'push', branch, rule, update }, config, bypass);
}
