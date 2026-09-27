import { existsSync } from 'node:fs';
import path from 'node:path';
import { git, gitMaybe, gitOk } from './exec.js';

export const ZERO_SHA_RE = /^0+$/;

export function isZeroSha(sha: string): boolean {
  return ZERO_SHA_RE.test(sha);
}

export function isSha(value: string): boolean {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(value);
}

export function repoRoot(cwd?: string): string | null {
  return gitMaybe(['rev-parse', '--show-toplevel'], { cwd });
}

export function requireRepoRoot(cwd?: string): string {
  const root = repoRoot(cwd);
  if (!root) throw new Error('Not inside a git working tree.');
  return root;
}

/** Absolute path of a file inside the git dir (respects worktrees via --git-path). */
export function gitPath(name: string, cwd?: string): string {
  const p = git(['rev-parse', '--git-path', name], { cwd });
  return path.resolve(cwd ?? process.cwd(), p);
}

export function commonGitDir(cwd?: string): string {
  const p = git(['rev-parse', '--git-common-dir'], { cwd });
  return path.resolve(cwd ?? process.cwd(), p);
}

export function hooksDir(cwd?: string): string {
  return gitPath('hooks', cwd);
}

export function currentBranch(cwd?: string): string | null {
  return gitMaybe(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
}

export function refExists(ref: string, cwd?: string): boolean {
  return gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
}

export function resolveRef(ref: string, cwd?: string): string | null {
  return gitMaybe(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
}

export function isAncestor(ancestor: string, descendant: string, cwd?: string): boolean {
  return gitOk(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
}

/** Local branches (short names) whose history contains `sha`, excluding `exclude`. */
export function localBranchesContaining(sha: string, exclude: string, cwd?: string): string[] {
  const out = gitMaybe(['for-each-ref', '--format=%(refname:short)', `--contains=${sha}`, 'refs/heads/'], { cwd });
  if (!out) return [];
  return out.split('\n').map((s) => s.trim()).filter((b) => b && b !== exclude);
}

export function remoteUrl(remote: string, cwd?: string): string | null {
  return gitMaybe(['remote', 'get-url', remote], { cwd });
}

/** Every URL git uses for `remote`: the fetch URL and all push URLs. */
export function remoteUrls(remote: string, cwd?: string): string[] {
  const fetch = remoteUrl(remote, cwd);
  const push = gitMaybe(['remote', 'get-url', '--push', '--all', remote], { cwd });
  const urls = [fetch, ...(push ?? '').split('\n')].map((u) => u?.trim()).filter((u): u is string => !!u);
  return [...new Set(urls)];
}

/** Whether ref names are case-insensitive in this repository (`core.ignorecase`, set by git on such filesystems). */
export function ignoresCase(cwd?: string): boolean {
  return gitMaybe(['config', '--bool', 'core.ignorecase'], { cwd }) === 'true';
}

/**
 * The remote's default branch as a remote-tracking ref (e.g. refs/remotes/origin/main).
 * Falls back to common names when refs/remotes/<remote>/HEAD is not set.
 */
export function remoteDefaultRef(remote: string, cwd?: string): string | null {
  const head = gitMaybe(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { cwd });
  if (head) return head;
  for (const name of ['main', 'master']) {
    const ref = `refs/remotes/${remote}/${name}`;
    if (refExists(ref, cwd)) return ref;
  }
  return null;
}

export type InProgressOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;

export function inProgressOperation(cwd?: string): InProgressOp {
  if (existsSync(gitPath('MERGE_HEAD', cwd))) return 'merge';
  if (existsSync(gitPath('rebase-merge', cwd)) || existsSync(gitPath('rebase-apply', cwd))) return 'rebase';
  if (existsSync(gitPath('CHERRY_PICK_HEAD', cwd))) return 'cherry-pick';
  if (existsSync(gitPath('REVERT_HEAD', cwd))) return 'revert';
  return null;
}

export function gitVersion(): [number, number, number] {
  const out = git(['--version']);
  const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function userIdentity(cwd?: string): string {
  const name = gitMaybe(['config', 'user.name'], { cwd }) ?? 'unknown';
  const email = gitMaybe(['config', 'user.email'], { cwd }) ?? 'unknown';
  return `${name} <${email}>`;
}
