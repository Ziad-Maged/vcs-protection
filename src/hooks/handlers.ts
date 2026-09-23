import { existsSync, readFileSync } from 'node:fs';
import { recordBypass } from '../audit/log.js';
import { loadConfig } from '../config/load.js';
import type { Config } from '../config/schema.js';
import {
  currentBranch,
  gitPath,
  inProgressOperation,
  isAncestor,
  isSha,
  isZeroSha,
  localBranchesContaining,
  remoteDefaultRef,
  resolveRef,
} from '../git/repo.js';
import { gitOk } from '../git/exec.js';
import { blockMessage, type MessageContext } from '../messages.js';
import { branchName, ruleFor } from '../rules/match.js';
import { evaluatePush, evaluateRefUpdate, type Decision, type RefUpdate, type RepoFacts } from '../rules/evaluate.js';
import { blockBox, warn } from '../ui.js';
import { BYPASS_ENV, bypassReason, githubRepoFor } from './context.js';
import { hookStatus, installHooks } from './install.js';
import type { HookName } from './shim.js';

/** Exit code: 0 lets git continue, 1 blocks the operation. */
export type HookExit = 0 | 1;

export function parseRefUpdates(input: string): RefUpdate[] {
  return input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [oldSha, newSha, ref] = line.split(/\s+/);
      // Symbolic-ref updates carry `ref:<target>` values instead of object ids; they never move a branch.
      if (!oldSha || !newSha || !ref || !isSha(oldSha) || !isSha(newSha)) return [];
      return [{ oldSha, newSha, ref }];
    });
}

/** Repo facts for the rule engine that also see refs updated earlier in the same transaction. */
export function liveFacts(pending: Map<string, string>): RepoFacts {
  const tipOf = (ref: string) => pending.get(ref) ?? resolveRef(ref);
  const contains = (tip: string | null | undefined, sha: string) =>
    !!tip && !isZeroSha(tip) && (tip === sha || isAncestor(sha, tip));
  return {
    onRemoteBranch: (sha, remote, branch) => contains(tipOf(`refs/remotes/${remote}/${branch}`), sha),
    onRemoteDefault: (sha, remote) => {
      const ref = remoteDefaultRef(remote);
      return !!ref && contains(tipOf(ref), sha);
    },
    isAncestor: (a, d) => isAncestor(a, d),
  };
}

function mergeHeadSha(): string | null {
  const file = gitPath('MERGE_HEAD');
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').split('\n')[0]?.trim() || null;
}

function report(decision: Exclude<Decision, { action: 'allow' }>, config: Config, hook: string): HookExit {
  if (decision.action === 'bypass') {
    recordBypass({
      hook,
      kind: decision.kind,
      ref: decision.update.ref,
      oldSha: decision.update.oldSha,
      newSha: decision.update.newSha,
      reason: decision.reason,
    });
    warn(`Protection bypassed for '${decision.branch}' (${BYPASS_ENV}="${decision.reason}"). This was logged.`);
    return 0;
  }

  const op = inProgressOperation();
  let sourceBranch: string | null = null;
  if (decision.kind === 'push') {
    sourceBranch = null; // filled by the pre-push handler
  } else if (decision.kind === 'advance') {
    const incoming = mergeHeadSha() ?? decision.update.newSha;
    sourceBranch = localBranchesContaining(incoming, decision.branch)[0] ?? null;
  }
  // Fast-forward merges and `reset --hard` update the index and working tree *before* the ref,
  // so a blocked update leaves them at the new commit. Tell the user how to put them back.
  // (Not for plain commits: there the index legitimately matches the new commit.)
  const worktreeMovedTo =
    op === null &&
    (sourceBranch !== null || decision.kind === 'rewrite') &&
    gitOk(['diff-index', '--cached', '--quiet', decision.update.newSha, '--'])
      ? decision.update.newSha
      : null;
  const ctx: MessageContext = {
    kind: decision.kind,
    branch: decision.branch,
    rule: decision.rule,
    repo: githubRepoFor(config),
    op,
    sourceBranch,
    bypassAllowed: config.bypass.allowed,
    worktreeMovedTo,
  };
  const msg = blockMessage(ctx);
  blockBox(msg.title, msg.lines);
  return 1;
}

export function handleReferenceTransaction(args: string[], input: string, config: Config): HookExit {
  if (args[0] !== 'prepared') return 0;
  const updates = parseRefUpdates(input);
  const pending = new Map(updates.map((u) => [u.ref, u.newSha]));
  const facts = liveFacts(pending);
  const bypass = { reason: bypassReason() };
  let exit: HookExit = 0;
  for (const update of updates) {
    const d = evaluateRefUpdate(update, config, facts, bypass);
    if (d.action !== 'allow' && report(d, config, 'reference-transaction') === 1) exit = 1;
  }
  return exit;
}

export function handlePrePush(args: string[], input: string, config: Config): HookExit {
  const remoteName = args[0] ?? '';
  const bypass = { reason: bypassReason() };
  let exit: HookExit = 0;
  for (const line of input.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (!localRef || !localSha || !remoteRef || !remoteSha) continue;
    const d = evaluatePush({ localRef, localSha, remoteRef, remoteSha }, remoteName, config, bypass);
    if (d.action === 'allow') continue;
    if (d.action === 'bypass') {
      report(d, config, 'pre-push');
      continue;
    }
    const source = localRef.startsWith('refs/heads/') ? branchName(localRef) : currentBranch();
    const msg = blockMessage({
      kind: d.kind,
      branch: d.branch,
      rule: d.rule,
      repo: githubRepoFor(config),
      op: null,
      sourceBranch: source,
      bypassAllowed: config.bypass.allowed,
    });
    blockBox(msg.title, msg.lines);
    exit = 1;
  }
  return exit;
}

/**
 * pre-commit / pre-merge-commit: fail early, before the editor opens. These hooks can be skipped
 * with --no-verify; the reference-transaction hook still blocks the resulting ref update.
 */
export function handlePreCommitLike(hook: 'pre-commit' | 'pre-merge-commit', config: Config): HookExit {
  const branch = currentBranch();
  if (!branch) return 0;
  const rule = ruleFor(config, branch);
  if (!rule) return 0;
  if (config.bypass.allowed && bypassReason()?.trim()) return 0;
  // Committing on a protected branch while resolving a rebase/cherry-pick onto commits that are
  // not the branch itself is caught later by reference-transaction with a better message.
  const merge = mergeHeadSha();
  const msg = blockMessage({
    kind: hook,
    branch,
    rule,
    repo: githubRepoFor(config),
    op: inProgressOperation(),
    sourceBranch: merge ? (localBranchesContaining(merge, branch)[0] ?? null) : null,
    bypassAllowed: config.bypass.allowed,
  });
  blockBox(msg.title, msg.lines);
  return 1;
}

/** post-checkout / post-merge: re-install shims that went missing or stale. Never blocks. */
export function handleSelfCheck(config: Config): HookExit {
  const broken = hookStatus(config.failMode).filter((h) => h.state === 'missing' || h.state === 'outdated');
  if (broken.length > 0) {
    installHooks(config.failMode, undefined, broken.map((b) => b.hook));
    warn(`Repaired git hooks: ${broken.map((b) => b.hook).join(', ')}`);
  }
  return 0;
}

export function runHook(hook: HookName, args: string[], input: string): HookExit {
  let config: Config | null = null;
  try {
    const loaded = loadConfig();
    if (!loaded) return 0;
    config = loaded.config;
    switch (hook) {
      case 'reference-transaction':
        return handleReferenceTransaction(args, input, config);
      case 'pre-push':
        return handlePrePush(args, input, config);
      case 'pre-commit':
      case 'pre-merge-commit':
        return handlePreCommitLike(hook, config);
      case 'post-checkout':
      case 'post-merge':
        return handleSelfCheck(config);
    }
  } catch (err) {
    const failClosed = config?.failMode === 'closed';
    warn(`Internal error in ${hook} hook: ${(err as Error).message}`);
    warn(failClosed ? 'failMode is "closed": blocking the operation.' : 'failMode is "open": allowing the operation.');
    return failClosed ? 1 : 0;
  }
}
