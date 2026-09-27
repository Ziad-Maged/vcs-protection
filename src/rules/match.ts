import picomatch from 'picomatch';
import type { BranchRule, Config } from '../config/schema.js';

export interface MatchOptions {
  /** Match regardless of case, for case-insensitive clones (`core.ignorecase`). */
  nocase?: boolean;
}

const matcherCache = new Map<string, (s: string) => boolean>();

function matcher(pattern: string, nocase: boolean): (s: string) => boolean {
  const key = `${nocase ? 'i' : 's'}:${pattern}`;
  let m = matcherCache.get(key);
  if (!m) {
    m = picomatch(pattern, { dot: true, nocase });
    matcherCache.set(key, m);
  }
  return m;
}

/** Strip `refs/heads/` if present. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The first rule protecting `branch` (short name or refs/heads/...), or null. */
export function ruleFor(config: Config, branch: string, opts: MatchOptions = {}): BranchRule | null {
  const name = branchName(branch);
  return config.protected.find((r) => matcher(r.pattern, !!opts.nocase)(name)) ?? null;
}

export function isProtected(config: Config, branch: string, opts: MatchOptions = {}): boolean {
  return ruleFor(config, branch, opts) !== null;
}
