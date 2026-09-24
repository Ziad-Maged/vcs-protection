import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciGuard } from '../../src/commands/ciGuard.js';
import { defaultConfig } from '../../src/config/schema.js';
import { GitHubClient, type PullRequest, type Review } from '../../src/github/client.js';
import type { CheckRun, WorkflowRun } from '../../src/github/client.js';
import {
  evaluatePoisonPill,
  handlePrEvent,
  judgePush,
  judgeWorkflowRun,
  remediatePush,
  summarizeReviews,
  type PushEvent,
} from '../../src/github/guard.js';

const repo = { host: 'github.com', owner: 'acme', repo: 'app' };
const BEFORE = '1'.repeat(40);
const AFTER = '2'.repeat(40);

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

/** A fake GitHub API: routes keyed by "METHOD path-suffix" return JSON. */
function fakeClient(routes: Record<string, unknown>): { client: GitHubClient; calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const path = url.replace('https://api.github.com/repos/acme/app', '').replace(/[?&]per_page=100&page=\d+/, '');
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { client: new GitHubClient(repo, 't', fetchImpl), calls, fetchImpl };
}

const pr = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  html_url: 'https://github.com/acme/app/pull/7',
  state: 'closed',
  merged_at: '2026-01-01T00:00:00Z',
  merge_commit_sha: AFTER,
  user: { login: 'author' },
  base: { ref: 'main', sha: BEFORE },
  head: { ref: 'feature', sha: '3'.repeat(40) },
  ...overrides,
});

const review = (id: number, login: string, state: Review['state'], at: string): Review => ({
  id,
  user: { login },
  state,
  submitted_at: at,
});

const push = (overrides: Partial<PushEvent> = {}): PushEvent => ({
  ref: 'refs/heads/main',
  before: BEFORE,
  after: AFTER,
  created: false,
  deleted: false,
  forced: false,
  sender: { login: 'pusher' },
  repository: { default_branch: 'main' },
  ...overrides,
});

const config = defaultConfig(['main'], 2);

describe('summarizeReviews', () => {
  it('uses each reviewer\'s latest decisive state and ignores the author', () => {
    const s = summarizeReviews(
      [
        review(1, 'bob', 'CHANGES_REQUESTED', '2026-01-01T01:00:00Z'),
        review(2, 'bob', 'COMMENTED', '2026-01-01T02:00:00Z'),
        review(3, 'bob', 'APPROVED', '2026-01-01T03:00:00Z'),
        review(4, 'carol', 'APPROVED', '2026-01-01T01:00:00Z'),
        review(5, 'carol', 'DISMISSED', '2026-01-01T04:00:00Z'),
        review(6, 'author', 'APPROVED', '2026-01-01T05:00:00Z'),
      ],
      'author',
    );
    expect(s.approvedBy).toEqual(['bob']);
    expect(s.changesRequestedBy).toEqual([]);
  });
});

describe('judgePush', () => {
  it('flags a direct push (commit not a PR merge commit)', async () => {
    const { client } = fakeClient({ [`GET /commits/${AFTER}/pulls`]: [] });
    expect(await judgePush(push(), config, client)).toMatchObject({ ok: false, kind: 'direct-push' });
  });

  it('flags force pushes without calling the API', async () => {
    const { client, calls } = fakeClient({});
    expect(await judgePush(push({ forced: true }), config, client)).toMatchObject({ ok: false, kind: 'force-push' });
    expect(calls).toHaveLength(0);
  });

  it('flags a PR merged with too few approvals', async () => {
    const { client } = fakeClient({
      [`GET /commits/${AFTER}/pulls`]: [pr()],
      'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED', 'x'), review(2, 'author', 'APPROVED', 'y')],
    });
    const v = await judgePush(push(), config, client);
    expect(v).toMatchObject({ ok: false, kind: 'insufficient-approvals' });
    expect(v.ok || v.reason).toContain('1/2 approvals');
  });

  it('accepts a PR merged with enough approvals', async () => {
    const { client } = fakeClient({
      [`GET /commits/${AFTER}/pulls`]: [pr()],
      'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED', 'x'), review(2, 'carol', 'APPROVED', 'y')],
    });
    expect(await judgePush(push(), config, client)).toMatchObject({ ok: true });
  });

  it('ignores unprotected branches and bypass users', async () => {
    const { client } = fakeClient({});
    expect((await judgePush(push({ ref: 'refs/heads/feature' }), config, client)).ok).toBe(true);
    const withBypass = { ...config, github: { ...config.github, bypassUsers: ['pusher'] } };
    expect((await judgePush(push(), withBypass, client)).ok).toBe(true);
  });

  it('flags deletion of a protected branch', async () => {
    const { client } = fakeClient({});
    expect(await judgePush(push({ deleted: true, after: '0'.repeat(40) }), config, client)).toMatchObject({
      ok: false,
      kind: 'deleted',
    });
  });
});

describe('remediatePush', () => {
  it('saves a rescue branch, resets the branch and opens an issue', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      'PATCH /git/refs/heads/main': {},
      'POST /issues': { html_url: 'https://github.com/acme/app/issues/1', number: 1 },
    });
    const verdict = { ok: false as const, kind: 'direct-push' as const, reason: 'direct', branch: 'main', rule: config.protected[0]! };
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls.map((c) => c.method + ' ' + c.url.split('/app')[1])).toEqual([
      'POST /git/refs',
      'GET /git/ref/heads/main',
      'PATCH /git/refs/heads/main',
      'POST /issues',
    ]);
    expect(calls[0]!.body).toEqual({ ref: `refs/heads/vcs-protection/rescue/main-${AFTER.slice(0, 7)}`, sha: AFTER });
    expect(calls[2]!.body).toEqual({ sha: BEFORE, force: true });
    expect(res.issueUrl).toBe('https://github.com/acme/app/issues/1');
  });

  it('does not reset when the branch moved again since the push', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /git/ref/heads/main': { object: { sha: '9'.repeat(40) } },
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const verdict = { ok: false as const, kind: 'direct-push' as const, reason: 'direct', branch: 'main', rule: config.protected[0]! };
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.actions.join('\n')).toContain('Did NOT move');
  });

  it('only reports in "report" mode', async () => {
    const { client, calls } = fakeClient({ 'POST /issues': { html_url: 'u', number: 1 } });
    const reportOnly = { ...config, github: { ...config.github, enforcement: 'report' as const } };
    const verdict = { ok: false as const, kind: 'direct-push' as const, reason: 'direct', branch: 'main', rule: config.protected[0]! };
    await remediatePush(push(), verdict, reportOnly, client);
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });
});

describe('handlePrEvent', () => {
  it('posts a failure status when approvals are missing', async () => {
    const head = '3'.repeat(40);
    const { client, calls } = fakeClient({
      'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED', 'x')],
      [`POST /statuses/${head}`]: {},
    });
    await handlePrEvent({ pull_request: pr({ state: 'open', merged_at: null }) }, config, client);
    expect(calls.at(-1)!.body).toMatchObject({ state: 'failure', context: 'vcs-protection/approvals' });
  });
});

const SUITE = 42;
const withPill = (pill: Partial<typeof config.github.poisonPill> = {}) => ({
  ...config,
  github: { ...config.github, poisonPill: { ...config.github.poisonPill, enabled: true, workflows: ['CI'], ...pill } },
});

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 1,
  name: 'CI',
  event: 'push',
  head_branch: 'main',
  head_sha: AFTER,
  conclusion: 'failure',
  check_suite_id: SUITE,
  html_url: 'https://github.com/acme/app/actions/runs/1',
  ...overrides,
});

const check = (name: string, conclusion: string | null, overrides: Partial<CheckRun> = {}): CheckRun => ({
  id: name.length,
  name,
  status: 'completed',
  conclusion,
  html_url: `https://github.com/acme/app/runs/${name}`,
  check_suite: { id: SUITE },
  ...overrides,
});

describe('evaluatePoisonPill', () => {
  const facts = (checkRuns: CheckRun[], stillOnBranch = true, parentCheckRuns: CheckRun[] = []) => ({
    checkRuns,
    stillOnBranch,
    parentCheckRuns,
    parentSha: BEFORE,
  });
  const failing = facts([check('test', 'failure'), check('lint', 'success')]);

  it('ignores runs it should not judge', () => {
    expect(evaluatePoisonPill(run(), config, failing).ok).toBe(true); // disabled
    expect(evaluatePoisonPill(run({ event: 'pull_request' }), withPill(), failing).ok).toBe(true);
    expect(evaluatePoisonPill(run({ head_branch: 'feature/x' }), withPill(), failing).ok).toBe(true);
    expect(evaluatePoisonPill(run({ name: 'Docs' }), withPill(), failing).ok).toBe(true);
  });

  it('is idempotent once the commit is no longer on the branch', () => {
    const v = evaluatePoisonPill(run(), withPill(), facts(failing.checkRuns, false));
    expect(v).toMatchObject({ ok: true, reason: expect.stringContaining('no longer on') });
  });

  it('passes when the critical checks passed', () => {
    expect(evaluatePoisonPill(run({ conclusion: 'success' }), withPill(), facts([check('test', 'success')])).ok).toBe(true);
  });

  it('counts failure and timed_out, but not cancelled or unfinished runs, by default', () => {
    expect(evaluatePoisonPill(run(), withPill(), facts([check('test', 'cancelled')])).ok).toBe(true);
    expect(evaluatePoisonPill(run(), withPill(), facts([check('test', null, { status: 'in_progress' })])).ok).toBe(true);
    const v = evaluatePoisonPill(run(), withPill(), facts([check('unit', 'failure'), check('e2e', 'timed_out')]));
    expect(v).toMatchObject({ ok: false, kind: 'poison-pill', branch: 'main' });
    if (!v.ok) {
      expect(v.reason).toContain('unit, e2e');
      expect(v.details).toContain('`e2e`: timed_out (https://github.com/acme/app/runs/e2e)');
      expect(v.details?.at(-1)).toContain('actions/runs/1');
    }
    expect(evaluatePoisonPill(run(), withPill({ conclusions: ['cancelled'] }), facts([check('t', 'cancelled')])).ok).toBe(false);
  });

  it('only looks at the completed workflow\'s own checks, narrowed by `checks`', () => {
    const other = check('test', 'failure', { check_suite: { id: 7 } });
    expect(evaluatePoisonPill(run(), withPill(), facts([other])).ok).toBe(true);
    const mixed = facts([check('flaky-lint', 'failure'), check('test', 'success')]);
    expect(evaluatePoisonPill(run(), withPill({ checks: ['test'] }), mixed).ok).toBe(true);
    expect(evaluatePoisonPill(run(), withPill(), mixed).ok).toBe(false);
  });
});

describe('evaluatePoisonPill: inherited failures', () => {
  const facts = (parentCheckRuns: CheckRun[]) => ({
    checkRuns: [check('unit', 'failure'), check('e2e', 'failure')],
    stillOnBranch: true,
    parentCheckRuns,
    parentSha: BEFORE,
  });
  const onParent = (name: string, conclusion: string | null, status = 'completed') =>
    check(name, conclusion, { status, check_suite: { id: 1 } });

  it('does not blame a commit for checks that already failed on its parent', () => {
    const v = evaluatePoisonPill(run(), withPill(), facts([onParent('unit', 'failure'), onParent('e2e', 'timed_out')]));
    expect(v).toMatchObject({ ok: true, reason: expect.stringContaining(`already failed on ${BEFORE.slice(0, 7)}`) });
  });

  it('still blames it when a check newly fails, or the parent was green or unfinished', () => {
    expect(evaluatePoisonPill(run(), withPill(), facts([onParent('unit', 'failure'), onParent('e2e', 'success')])).ok).toBe(false);
    expect(evaluatePoisonPill(run(), withPill(), facts([onParent('unit', null, 'in_progress'), onParent('e2e', null, 'in_progress')])).ok).toBe(false);
  });
});

describe('judgeWorkflowRun', () => {
  const routes = (tip: string, parents = [BEFORE, '4'.repeat(40)]) => ({
    'GET /git/ref/heads/main': { object: { sha: tip } },
    [`GET /compare/${AFTER}...${tip}`]: { status: 'ahead' },
    [`GET /commits/${AFTER}/check-runs`]: { total_count: 1, check_runs: [check('test', 'failure')] },
    [`GET /commits/${AFTER}`]: { sha: AFTER, parents: parents.map((sha) => ({ sha })) },
    [`GET /commits/${BEFORE}/check-runs`]: { total_count: 1, check_runs: [check('test', 'success')] },
    [`GET /commits/${AFTER}/pulls`]: [pr()],
  });

  it('turns a failing critical run into a push from the parent commit', async () => {
    const { client } = fakeClient(routes(AFTER));
    const { verdict, push } = await judgeWorkflowRun({ workflow_run: run(), sender: { login: 'merger' } }, withPill(), client);
    expect(verdict).toMatchObject({ ok: false, kind: 'poison-pill', revertCommand: `git revert -m 1 ${AFTER}` });
    expect(!verdict.ok && verdict.pr?.number).toBe(7);
    expect(push).toEqual({
      ref: 'refs/heads/main',
      before: BEFORE,
      after: AFTER,
      created: false,
      deleted: false,
      forced: false,
      sender: { login: 'merger' },
    });
  });

  it('uses a plain revert for a non-merge commit and checks a moved tip with compare', async () => {
    const tip = '9'.repeat(40);
    const { client, calls } = fakeClient(routes(tip, [BEFORE]));
    const { verdict } = await judgeWorkflowRun({ workflow_run: run() }, withPill(), client);
    expect(verdict).toMatchObject({ ok: false, revertCommand: `git revert ${AFTER}` });
    expect(calls.some((c) => c.url.includes(`/compare/${AFTER}...${tip}`))).toBe(true);
  });

  it('skips remediation when the parent already failed the same check', async () => {
    const { client } = fakeClient({
      ...routes(AFTER),
      [`GET /commits/${BEFORE}/check-runs`]: { total_count: 1, check_runs: [check('test', 'failure', { check_suite: { id: 1 } })] },
    });
    const { verdict, push } = await judgeWorkflowRun({ workflow_run: run() }, withPill(), client);
    expect(verdict.ok).toBe(true);
    expect(push).toBeUndefined();
  });

  it('makes no API calls for runs it ignores', async () => {
    const { client, calls } = fakeClient({});
    const { verdict } = await judgeWorkflowRun({ workflow_run: run({ event: 'pull_request' }) }, withPill(), client);
    expect(verdict.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('remediatePush for a poison pill', () => {
  const verdict = {
    ok: false as const,
    kind: 'poison-pill' as const,
    reason: 'Critical checks failed',
    branch: 'main',
    rule: config.protected[0]!,
    details: ['`test`: failure (u)'],
    revertCommand: `git revert -m 1 ${AFTER}`,
  };

  it('resets the branch to the parent while the bad commit is still the tip', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      'PATCH /git/refs/heads/main': {},
      'POST /issues': { html_url: 'u', number: 1 },
    });
    await remediatePush(push(), verdict, withPill(), client);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sha: BEFORE, force: true });
    const issue = calls.at(-1)!.body as { title: string; body: string };
    expect(issue.title).toBe(`vcs-protection: poison-pill on main (${AFTER.slice(0, 7)})`);
    expect(issue.body).toContain('broke a critical CI workflow');
    expect(issue.body).toContain('  - `test`: failure (u)');
    expect(issue.body).toContain('Fix the failing checks');
    expect(issue.body).not.toContain('git revert');
  });

  it('keeps newer commits and explains how to revert when the tip moved', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /git/ref/heads/main': { object: { sha: '9'.repeat(40) } },
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const res = await remediatePush(push(), verdict, withPill(), client);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.actions.join('\n')).toContain('Did NOT move');
    const body = (calls.at(-1)!.body as { body: string }).body;
    expect(body).toContain(`git revert -m 1 ${AFTER}`);
    expect(body).toContain('because newer commits landed on top of it');
  });
});

describe('ci-guard on workflow_run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vcsp-ci-'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  /** Run ci-guard for a workflow_run event against fake API routes; returns exit code and API calls. */
  async function guard(rules: object, tip: string) {
    const { calls, fetchImpl } = fakeClient({
      [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: BEFORE }] },
      [`GET /contents/.vcs-protection.json?ref=${BEFORE}`]: {
        content: Buffer.from(JSON.stringify(rules)).toString('base64'),
        encoding: 'base64',
      },
      'GET /git/ref/heads/main': { object: { sha: tip } },
      [`GET /commits/${AFTER}/check-runs`]: { total_count: 1, check_runs: [check('test', 'failure')] },
      [`GET /commits/${BEFORE}/check-runs`]: { total_count: 0, check_runs: [] },
      [`GET /commits/${AFTER}/pulls`]: [pr()],
      'POST /git/refs': {},
      'PATCH /git/refs/heads/main': {},
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const event = path.join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ workflow_run: run(), sender: { login: 'merger' } }));
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_run');
    vi.stubEnv('GITHUB_EVENT_PATH', event);
    vi.stubEnv('GITHUB_REPOSITORY', 'acme/app');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await ciGuard();
    vi.restoreAllMocks();
    return { code, calls };
  }

  it('judges by the rules at the parent commit and remediates a breach', async () => {
    const rules = { version: 1, protected: [{ pattern: 'main' }], github: { poisonPill: { enabled: true, workflows: ['CI'] } } };
    const { code, calls } = await guard(rules, AFTER);
    expect(code).toBe(1);
    expect(calls.some((c) => c.url.includes(`ref=${BEFORE}`))).toBe(true);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sha: BEFORE, force: true });
    expect(calls.at(-1)!.method + (calls.at(-1)!.body as { title: string }).title).toContain('POSTvcs-protection: poison-pill on main');
  });

  it('does nothing when the rules before the merge had the poison pill off', async () => {
    const { code, calls } = await guard({ version: 1, protected: [{ pattern: 'main' }] }, AFTER);
    expect(code).toBe(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('cleans up', () => rmSync(dir, { recursive: true, force: true }));
});
