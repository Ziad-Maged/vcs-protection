import { describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../../src/config/schema.js';
import { evaluatePush, evaluateRefUpdate, type RepoFacts } from '../../src/rules/evaluate.js';
import { isProtected } from '../../src/rules/match.js';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const config: Config = defaultConfig(['main', 'release/*']);

/** Remote main is at A. B is a new local commit on top of A. C is unrelated history. */
const facts: RepoFacts = {
  onRemoteBranch: (sha, remote, branch) => remote === 'origin' && branch === 'main' && sha === A,
  onRemoteDefault: (sha) => sha === A,
  isAncestor: (a, d) => a === d || (a === A && d === B),
  currentSha: (ref) => (ref === 'refs/heads/main' ? A : null),
};

const upd = (oldSha: string, newSha: string, ref = 'refs/heads/main') => ({ oldSha, newSha, ref });

describe('pattern matching', () => {
  it('matches exact names and globs', () => {
    expect(isProtected(config, 'main')).toBe(true);
    expect(isProtected(config, 'refs/heads/main')).toBe(true);
    expect(isProtected(config, 'release/1.0')).toBe(true);
    expect(isProtected(config, 'release/1.0/hotfix')).toBe(false);
    expect(isProtected(config, 'feature/x')).toBe(false);
    expect(isProtected(config, 'mainline')).toBe(false);
  });
});

describe('evaluateRefUpdate', () => {
  it('ignores unprotected branches and non-branch refs', () => {
    expect(evaluateRefUpdate(upd(A, B, 'refs/heads/feature'), config, facts).action).toBe('allow');
    expect(evaluateRefUpdate(upd(A, B, 'refs/remotes/origin/main'), config, facts).action).toBe('allow');
    expect(evaluateRefUpdate(upd(A, B, 'refs/tags/v1'), config, facts).action).toBe('allow');
  });

  it('allows moving to commits already on the remote branch (pull, reset to origin)', () => {
    expect(evaluateRefUpdate(upd(C, A), config, facts).action).toBe('allow');
  });

  it('allows local deletion', () => {
    expect(evaluateRefUpdate(upd(A, Z), config, facts).action).toBe('allow');
  });

  it('blocks new local commits as "advance"', () => {
    const d = evaluateRefUpdate(upd(A, B), config, facts);
    expect(d).toMatchObject({ action: 'block', kind: 'advance', branch: 'main' });
  });

  it('blocks moving to unrelated history as "rewrite"', () => {
    const d = evaluateRefUpdate(upd(A, C), config, facts);
    expect(d).toMatchObject({ action: 'block', kind: 'rewrite' });
  });

  it('allows creating a protected branch from remote history, blocks from local-only commits', () => {
    expect(evaluateRefUpdate(upd(Z, A, 'refs/heads/release/2.0'), config, facts).action).toBe('allow');
    expect(evaluateRefUpdate(upd(Z, B, 'refs/heads/release/2.0'), config, facts)).toMatchObject({
      action: 'block',
      kind: 'create',
    });
  });

  it('judges a forced update of an existing branch (zero old value) as a move, not a creation', () => {
    // `git branch -f release/1 origin/main` while release/1 exists at C, which isn't on the remote.
    const withRelease: RepoFacts = { ...facts, currentSha: (ref) => (ref === 'refs/heads/release/1' ? C : null) };
    expect(evaluateRefUpdate(upd(Z, A, 'refs/heads/release/1'), config, withRelease)).toMatchObject({
      action: 'block',
      kind: 'rewrite',
    });
    // `git update-ref refs/heads/main <local commit>`: an advance, reported as such.
    expect(evaluateRefUpdate(upd(Z, B), config, facts)).toMatchObject({ action: 'block', kind: 'advance' });
    // Syncing with a forced update is still fine.
    expect(evaluateRefUpdate(upd(Z, A), config, facts).action).toBe('allow');
  });

  it('turns a block into a bypass when a reason is given and bypass is allowed', () => {
    expect(evaluateRefUpdate(upd(A, B), config, facts, { reason: 'hotfix' })).toMatchObject({
      action: 'bypass',
      reason: 'hotfix',
    });
    expect(evaluateRefUpdate(upd(A, B), config, facts, { reason: '  ' }).action).toBe('block');
    const strict = { ...config, bypass: { allowed: false } };
    expect(evaluateRefUpdate(upd(A, B), strict, facts, { reason: 'hotfix' }).action).toBe('block');
  });
});

describe('evaluatePush', () => {
  const push = (remoteRef: string, localSha: string, remoteSha: string) => ({
    localRef: 'refs/heads/feature',
    localSha,
    remoteRef,
    remoteSha,
  });

  it('blocks pushing to a protected branch on the configured remote', () => {
    expect(evaluatePush(push('refs/heads/main', B, A), true, config)).toMatchObject({ action: 'block', kind: 'push' });
  });

  it('blocks deleting a protected branch unless the rule allows it', () => {
    expect(evaluatePush(push('refs/heads/main', Z, A), true, config)).toMatchObject({ kind: 'push-delete' });
    const lax = defaultConfig(['main']);
    lax.protected[0]!.allowDeletion = true;
    expect(evaluatePush(push('refs/heads/main', Z, A), true, lax).action).toBe('allow');
  });

  it('allows feature branches, other remotes and no-op pushes', () => {
    expect(evaluatePush(push('refs/heads/feature', B, A), true, config).action).toBe('allow');
    expect(evaluatePush(push('refs/heads/main', B, A), false, config).action).toBe('allow');
    expect(evaluatePush(push('refs/heads/main', A, A), true, config).action).toBe('allow');
  });
});
