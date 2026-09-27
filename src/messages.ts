import type { BranchRule } from './config/schema.js';
import { compareUrl, type GitHubRepo } from './github/remote.js';
import type { InProgressOp } from './git/repo.js';
import type { BlockKind } from './rules/evaluate.js';

export interface MessageContext {
  kind: BlockKind | 'pre-commit' | 'pre-merge-commit';
  branch: string;
  rule: BranchRule;
  repo: GitHubRepo | null;
  op: InProgressOp;
  /** A local branch that holds the commits being brought in (for merge / push suggestions). */
  sourceBranch: string | null;
  bypassAllowed: boolean;
  /** The shared remote (`config.remote`); defaults to `origin`. */
  remote?: string;
  /** Set when git already moved the index/working tree to this commit before the ref update was refused. */
  worktreeMovedTo?: string | null;
}

export interface Message {
  title: string;
  lines: string[];
}

function approvalsText(rule: BranchRule): string {
  const n = rule.requiredApprovals;
  if (n === 0) return 'a pull request on GitHub';
  return `a pull request on GitHub approved by ${n} other team member${n === 1 ? '' : 's'}`;
}

function prLines(ctx: MessageContext, head: string | null): string[] {
  const lines: string[] = [];
  const h = head ?? '<your-branch>';
  if (ctx.repo) {
    lines.push(`Open a pull request: ${compareUrl(ctx.repo, ctx.branch, h)}`);
  } else {
    lines.push(`Then open a pull request from '${h}' into '${ctx.branch}' on GitHub.`);
  }
  return lines;
}

function footer(ctx: MessageContext): string[] {
  const lines = [''];
  if (ctx.worktreeMovedTo) {
    lines.push(
      `Git already updated your files, but '${ctx.branch}' did not move. Restore them (keeps your other local edits):`,
      `  git read-tree -m -u ${ctx.worktreeMovedTo.slice(0, 12)} HEAD`,
      '',
    );
  }
  if (ctx.bypassAllowed) {
    lines.push(`Emergency only: VCS_PROTECTION_BYPASS="<reason>" <command> (logged; the GitHub guard may still revert it).`);
  }
  return lines;
}

export function blockMessage(ctx: MessageContext): Message {
  const b = `'${ctx.branch}'`;
  const r = ctx.remote ?? 'origin';
  const isMerge = ctx.kind === 'pre-merge-commit' || ctx.op === 'merge' || (ctx.kind === 'advance' && ctx.sourceBranch !== null);

  if (ctx.kind === 'push' || ctx.kind === 'push-delete') {
    const verb = ctx.kind === 'push-delete' ? 'Deleting' : 'Pushing directly to';
    return {
      title: `${verb} protected branch ${b} is not allowed.`,
      lines: [
        `Changes reach ${b} only through ${approvalsText(ctx.rule)}.`,
        ...(ctx.kind === 'push'
          ? [
              `Push to a feature branch instead: git push -u ${r} HEAD:${ctx.sourceBranch && ctx.sourceBranch !== ctx.branch ? ctx.sourceBranch : '<feature-branch>'}`,
              ...prLines(ctx, ctx.sourceBranch !== ctx.branch ? ctx.sourceBranch : null),
            ]
          : []),
        ...footer(ctx),
      ],
    };
  }

  if (isMerge) {
    return {
      title: `Merging into protected branch ${b} is not allowed.`,
      lines: [
        `Merges into ${b} must go through ${approvalsText(ctx.rule)}.`,
        ...(ctx.sourceBranch ? [`Push the branch: git push -u ${r} ${ctx.sourceBranch}`] : []),
        ...prLines(ctx, ctx.sourceBranch),
        ...(ctx.op === 'merge' ? ['Undo the attempted merge with: git merge --abort'] : []),
        ...footer(ctx),
      ],
    };
  }

  if (ctx.kind === 'rewrite') {
    return {
      title: `Rewriting protected branch ${b} is not allowed.`,
      lines: [
        `${b} can only move to commits that already exist on ${r}/${ctx.branch}.`,
        `To sync with the remote: git fetch && git reset --hard ${r}/${ctx.branch}`,
        ...(ctx.op === 'rebase' ? ['Abort the rebase with: git rebase --abort'] : []),
        ...footer(ctx),
      ],
    };
  }

  if (ctx.kind === 'create') {
    return {
      title: `Creating protected branch ${b} from local-only commits is not allowed.`,
      lines: [
        `Create ${b} from a commit that already exists on the remote, e.g.: git branch ${ctx.branch} ${r}/HEAD`,
        ...footer(ctx),
      ],
    };
  }

  // 'advance' without a source branch, or 'pre-commit'
  return {
    title: `Direct commits to protected branch ${b} are not allowed.`,
    lines: [
      `Changes reach ${b} only through ${approvalsText(ctx.rule)}.`,
      `Move your work to a new branch: git switch -c <feature-branch>`,
      ...(ctx.kind === 'advance' && ctx.op === 'cherry-pick' ? ['Abort with: git cherry-pick --abort'] : []),
      ...(ctx.kind === 'advance' && ctx.op === 'revert' ? ['Abort with: git revert --abort'] : []),
      ...(ctx.op === 'rebase' ? ['Abort the rebase with: git rebase --abort'] : []),
      ...footer(ctx),
    ],
  };
}
