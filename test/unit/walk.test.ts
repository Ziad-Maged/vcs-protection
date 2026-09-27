import { describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '../../src/config/schema.js';
import { approvalFor, summarizeReviews } from '../../src/github/approvals.js';
import type { PullRequest, Review } from '../../src/github/client.js';
import { finalRules, judgeChain, planRemediation, type ChainCommit, type ChainFacts, type FactCommit } from '../../src/github/walk.js';

const sha = (c: string) => c.repeat(40);
const A = sha('a'); // accepted boundary
const X1 = sha('1');
const X2 = sha('2');
const M = sha('d'); // a PR merge commit

const config: Config = defaultConfig(['main'], 1);

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'closed',
  merged_at: '2026-01-01T00:00:00Z',
  merge_commit_sha: M,
  user: { login: 'author' },
  base: { ref: 'main', sha: A },
  head: { ref: 'feature', sha: sha('e') },
  ...overrides,
});

const review = (id: number, login: string, state: Review['state'], commit = pr().head.sha): Review => ({
  id,
  user: { login },
  state,
  submitted_at: `2026-01-01T0${id}:00:00Z`,
  commit_id: commit,
});

const commit = (s: string, parent: string, overrides: Partial<FactCommit> = {}): FactCommit => ({
  sha: s,
  parents: [parent],
  config,
  reported: false,
  prs: [],
  ...overrides,
});

const facts = (commits: FactCommit[], overrides: Partial<ChainFacts> = {}): ChainFacts => ({
  branch: 'main',
  commits,
  boundaryConfig: config,
  reviews: new Map([[7, [review(1, 'bob', 'APPROVED')]]]),
  eligible: new Set(['bob']),
  pushes: [],
  ...overrides,
});

describe('summarizeReviews / approvalFor', () => {
  it("uses each reviewer's latest decisive state and ignores the author", () => {
    const s = summarizeReviews(
      [
        review(1, 'bob', 'CHANGES_REQUESTED'),
        review(2, 'bob', 'COMMENTED'),
        review(3, 'bob', 'APPROVED'),
        review(4, 'carol', 'APPROVED'),
        review(5, 'carol', 'DISMISSED'),
        review(6, 'author', 'APPROVED'),
      ],
      'author',
    );
    expect(s.approvedBy).toEqual(['bob']);
    expect(s.changesRequestedBy).toEqual([]);
  });

  it('ignores reviewers without write access, including their change requests', () => {
    const reviews = [review(1, 'bob', 'APPROVED'), review(2, 'stranger', 'APPROVED'), review(3, 'reader', 'CHANGES_REQUESTED')];
    const rule = { pattern: 'main', requiredApprovals: 2, allowDeletion: false };
    const check = approvalFor(pr(), reviews, rule, { eligible: (l) => l === 'bob' });
    expect(check).toMatchObject({ ok: false, description: '1/2 approvals' });
  });

  it('with dismissStaleApprovals, only counts approvals of the final head commit', () => {
    const rule = { pattern: 'main', requiredApprovals: 1, allowDeletion: false };
    const stale = [review(1, 'bob', 'APPROVED', sha('0'))];
    expect(approvalFor(pr(), stale, rule, {}).ok).toBe(true);
    expect(approvalFor(pr(), stale, rule, { dismissStaleApprovals: true }).ok).toBe(false);
    expect(approvalFor(pr(), [review(1, 'bob', 'APPROVED')], rule, { dismissStaleApprovals: true }).ok).toBe(true);
  });
});

describe('judgeChain', () => {
  it('accepts approved merge commits and flags direct pushes', () => {
    const chain = judgeChain(facts([commit(M, X1, { prs: [pr()] }), commit(X1, A)]));
    expect(chain.map((c) => [c.sha, c.verdict.ok])).toEqual([
      [M, true],
      [X1, false],
    ]);
    expect(chain[1]!.verdict).toMatchObject({ kind: 'direct-push' });
  });

  it('flags a merge whose PR lacks approvals from people with write access', () => {
    const chain = judgeChain(facts([commit(M, A, { prs: [pr()] })], { eligible: new Set() }));
    expect(chain[0]!.verdict).toMatchObject({ ok: false, kind: 'insufficient-approvals' });
  });

  it('accepts the commits of a rebase-merged PR whose last commit is further up the chain', () => {
    const rebased = pr({ merge_commit_sha: X2 });
    const chain = judgeChain(facts([commit(X2, X1, { prs: [rebased] }), commit(X1, A, { prs: [rebased] })]));
    expect(chain.every((c) => c.verdict.ok)).toBe(true);
  });

  it('accepts commits brought in by a push of a bypass user, even without that push\'s own run', () => {
    const cfg = { ...config, github: { ...config.github, bypassUsers: ['release-bot'] } };
    const commits = [commit(X2, X1, { config: cfg }), commit(X1, A, { config: cfg })];
    // release-bot pushed A..X1 ([skip ci]); mallory pushed X1..X2.
    const pushes = [
      { before: A, after: X1, actor: 'release-bot' },
      { before: X1, after: X2, actor: 'mallory' },
    ];
    const chain = judgeChain(facts(commits, { boundaryConfig: cfg, pushes }));
    expect(chain.map((c) => c.verdict.ok)).toEqual([false, true]);
    expect(chain[1]!.verdict).toMatchObject({ reason: 'release-bot is in github.bypassUsers' });
    // A push by someone who isn't a bypass user covers nothing.
    const other = judgeChain(facts(commits, { boundaryConfig: cfg, pushes: [{ before: A, after: X2, actor: 'mallory' }] }));
    expect(other.every((c) => !c.verdict.ok)).toBe(true);
  });

  it('keeps the rules when an unverified commit deletes or breaks the config', () => {
    // X1 (unverified) has no config at all: it must not switch protection off for X1 or X2.
    const chain = judgeChain(facts([commit(X2, X1, { config: null }), commit(X1, A, { config: null })]));
    expect(chain.map((c) => c.verdict.ok)).toEqual([false, false]);
    expect(finalRules(chain, [commit(X2, X1, { config: null }), commit(X1, A, { config: null })], config)).toBe(config);
  });

  it('finalRules are those of the newest verified commit', () => {
    const newer = defaultConfig(['main', 'release/*'], 1);
    const commits = [commit(X2, M), commit(M, A, { config: newer, prs: [pr()] })];
    const chain = judgeChain(facts(commits));
    expect(chain.map((c) => c.verdict.ok)).toEqual([false, true]);
    expect(finalRules(chain, commits, config)).toBe(newer);
  });

  it('accepts everything up to and including the commit that introduced protection', () => {
    const chain = judgeChain(facts([commit(X2, X1), commit(X1, A)], { boundaryConfig: null }));
    // X1 (bootstrap) is judged without rules; X2 by X1's rules, which protect main.
    expect(chain.map((c) => c.verdict.ok)).toEqual([false, true]);
  });

  it('an unverified commit cannot relax the rules for the commits on top of it', () => {
    const relaxed = defaultConfig([], 1);
    const chain = judgeChain(facts([commit(X2, X1), commit(X1, A, { config: relaxed })]));
    expect(chain.map((c) => c.verdict.ok)).toEqual([false, false]);
  });
});

describe('planRemediation', () => {
  const judged = (s: string, ok: boolean, reported = false): ChainCommit => ({
    sha: s,
    parents: [s === X2 ? X1 : A],
    reported,
    verdict: ok
      ? { ok: true, reason: 'ok' }
      : { ok: false, kind: 'direct-push', reason: 'direct', rule: config.protected[0]! },
  });

  it('resets to before the oldest violation when every newer commit is a violation too', () => {
    const plan = planRemediation([judged(X2, false), judged(X1, false)], 'revert');
    expect(plan).toMatchObject({ resetTo: A, accept: [] });
    expect(plan.newViolations).toHaveLength(2);
  });

  it('reports instead of resetting when a reviewed commit landed on top', () => {
    const plan = planRemediation([judged(X2, true), judged(X1, false)], 'revert');
    expect(plan).toMatchObject({ resetTo: null, accept: [X2] });
    expect(plan.noResetReason).toContain('reviewed changes');
  });

  it('never resets in report mode', () => {
    expect(planRemediation([judged(X1, false)], 'report').resetTo).toBeNull();
  });

  it('does not count already reported violations as new', () => {
    const plan = planRemediation([judged(X2, false), judged(X1, false, true)], 'report');
    expect(plan.newViolations.map((c) => c.sha)).toEqual([X2]);
  });
});
