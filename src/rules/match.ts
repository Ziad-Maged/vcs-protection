import picomatch from 'picomatch';
import type { BranchRule, Config } from '../config/schema.js';

const matcherCache = new Map<string, (s: string) => boolean>();

function matcher(pattern: string): (s: string) => boolean {
  let m = matcherCache.get(pattern);
  if (!m) {
    m = picomatch(pattern, { dot: true });
    matcherCache.set(pattern, m);
  }
  return m;
}

/** Strip `refs/heads/` if present. */
export function branchName(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** The first rule protecting `branch` (short name or refs/heads/...), or null. */
export function ruleFor(config: Config, branch: string): BranchRule | null {
  const name = branchName(branch);
  return config.protected.find((r) => matcher(r.pattern)(name)) ?? null;
}

export function isProtected(config: Config, branch: string): boolean {
  return ruleFor(config, branch) !== null;
}
