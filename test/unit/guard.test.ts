import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ciGuard } from '../../src/commands/ciGuard.js';
import { defaultConfig, type Config } from '../../src/config/schema.js';
import { GitHubClient, type CheckRun, type PullRequest, type Review, type WorkflowRun } from '../../src/github/client.js';
import {
  evaluatePoisonPill,
  guardBranch,
  handleDeleteEvent,
  handlePrEvent,
  judgePush,
  judgeWorkflowRun,
  landedRange,
  remediatePush,
  type PushEvent,
} from '../../src/github/guard.js';

const repo = { host: 'github.com', owner: 'acme', repo: 'app' };
const sha = (c: string) => c.repeat(40);
const BEFORE = sha('1');
const AFTER = sha('2');
const GUARD = 'github-actions[bot]';

interface Call {
  method: string;
  key: string;
  url: string;
  body?: unknown;
}

/** A route's reply: a JSON body (200), `reply(status, body)`, or a function of the request body. */
type Route = unknown;
const REPLY = Symbol('reply');
const reply = (status: number, body: unknown = {}) => ({ [REPLY]: true, status, body });

/**
 * A fake GitHub API. Routes are keyed by "METHOD path?query" relative to the repository
 * (paging parameters are ignored); `POST /graphql` is the GraphQL endpoint.
 */
function fakeClient(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const u = new URL(url);
    u.searchParams.delete('per_page');
    u.searchParams.delete('page');
    const q = u.searchParams.toString();
    const key = `${method} ${u.pathname.replace('/repos/acme/app', '') || '/'}${q ? `?${q}` : ''}`;
    calls.push({ method, key, url, body });
    if (!(key in routes)) return new Response('not found', { status: 404 });
    let r = routes[key];
    if (typeof r === 'function') r = (r as (b: unknown) => unknown)(body);
    const { status, body: out } =
      r && typeof r === 'object' && REPLY in r ? (r as unknown as { status: number; body: unknown }) : { status: 200, body: r };
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
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
  head: { ref: 'feature', sha: sha('3') },
  ...overrides,
});

const review = (id: number, login: string, state: Review['state']): Review => ({
  id,
  user: { login },
  state,
  submitted_at: `2026-01-01T0${id}:00:00Z`,
  commit_id: sha('3'),
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
const b64 = (c: object) => ({ content: Buffer.from(JSON.stringify(c)).toString('base64'), encoding: 'base64' });
const RULES = { version: 1, protected: [{ pattern: 'main', requiredApprovals: 2 }] };
const marker = (branch: string, state = 'success', login = GUARD) => [
  { state, context: `vcs-protection/accepted/${branch}`, description: 'ok', creator: { login } },
];
const accepted = marker('main');
const graphqlOk = { data: { updateRefs: { clientMutationId: null } } };
const titles = (calls: Call[]) => calls.filter((c) => c.key === 'POST /issues').map((c) => (c.body as { title: string }).title);

// -------------------------------------------------------------------------------------------------

describe('judgePush (event-level checks)', () => {
  it('flags force pushes and deletions without calling the API', async () => {
    const { client, calls } = fakeClient({});
    expect(await judgePush(push({ forced: true }), config, client)).toMatchObject({ ok: false, kind: 'force-push' });
    expect(await judgePush(push({ deleted: true, after: sha('0') }), config, client)).toMatchObject({ kind: 'deleted' });
    expect(calls).toHaveLength(0);
  });

  it('leaves regular pushes to the history walk', async () => {
    const { client, calls } = fakeClient({});
    expect(await judgePush(push(), config, client)).toEqual({ ok: true, reason: 'regular push' });
    expect(calls).toHaveLength(0);
  });

  it('allows re-creating a protected branch at a commit the guard had verified', async () => {
    const created = push({ created: true, before: sha('0'), ref: 'refs/heads/release/1' });
    const cfg = defaultConfig(['main', 'release/*']);
    const { client } = fakeClient({ [`GET /commits/${AFTER}/statuses`]: marker('release/1') });
    expect(await judgePush(created, cfg, client)).toMatchObject({ ok: true, reason: expect.stringContaining('verified') });
  });
});

describe('remediatePush', () => {
  const verdict = { ok: false as const, kind: 'force-push' as const, reason: 'forced', branch: 'main', rule: config.protected[0]! };

  it('saves a rescue branch, resets atomically through GraphQL and opens an issue', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /': { default_branch: 'main', node_id: 'R_1' },
      'POST /graphql': graphqlOk,
      'POST /issues': { html_url: 'https://github.com/acme/app/issues/1', number: 1 },
    });
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls[0]!.body).toEqual({ ref: `refs/heads/vcs-protection/rescue/main-${AFTER.slice(0, 7)}`, sha: AFTER });
    const gql = calls.find((c) => c.key === 'POST /graphql')!.body as { variables: unknown };
    expect(gql.variables).toEqual({
      repo: 'R_1',
      updates: [{ name: 'refs/heads/main', beforeOid: AFTER, afterOid: BEFORE, force: true }],
    });
    expect(res.issueUrl).toBe('https://github.com/acme/app/issues/1');
  });

  it('does not reset when the compare-and-swap fails (the branch moved)', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': { errors: [{ message: 'Expected refs/heads/main to point to 2222' }] },
      'GET /git/ref/heads/main': { object: { sha: sha('9') } },
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(res.actions.join('\n')).toContain('Did NOT move');
  });

  it('falls back to read-then-write where the GraphQL mutation does not exist', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': { errors: [{ message: "Field 'updateRefs' doesn't exist on type 'Mutation'" }] },
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      'PATCH /git/refs/heads/main': {},
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sha: BEFORE, force: true });
    expect(res.actions.join('\n')).toContain('without an atomic check');
  });

  it('never resets when the rescue branch could not be saved', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': reply(422, { message: 'Reference already exists' }),
      [`GET /git/ref/heads/vcs-protection/rescue/main-${AFTER.slice(0, 7)}`]: { object: { sha: sha('8') } },
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const res = await remediatePush(push(), verdict, config, client);
    expect(calls.some((c) => c.key === 'POST /graphql' || c.method === 'PATCH')).toBe(false);
    expect(res.actions.join('\n')).toContain('Could NOT save');
  });

  it('only reports in "report" mode', async () => {
    const { client, calls } = fakeClient({ 'POST /issues': { html_url: 'u', number: 1 } });
    const reportOnly = { ...config, github: { ...config.github, enforcement: 'report' as const } };
    await remediatePush(push(), verdict, reportOnly, client);
    expect(calls.map((c) => c.key)).toEqual(['POST /issues']);
  });
});

// -------------------------------------------------------------------------------------------------

describe('guardBranch (history walk)', () => {
  const A = sha('a');
  const X1 = sha('b');
  const X2 = sha('c');

  /** main: A (accepted) <- X1 <- tip. */
  const history = (tip: string, tipPulls: PullRequest[] = [], extra: Record<string, Route> = {}) => ({
    'GET /git/ref/heads/main': { object: { sha: tip } },
    [`GET /commits/${tip}/statuses`]: [],
    [`GET /commits/${X1}/statuses`]: [],
    [`GET /commits/${A}/statuses`]: accepted,
    [`GET /contents/.vcs-protection.json?ref=${tip}`]: b64(RULES),
    [`GET /contents/.vcs-protection.json?ref=${X1}`]: b64(RULES),
    [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(RULES),
    [`GET /commits/${tip}`]: { sha: tip, parents: [{ sha: X1 }] },
    [`GET /commits/${X1}`]: { sha: X1, parents: [{ sha: A }] },
    [`GET /commits/${tip}/pulls`]: tipPulls,
    [`GET /commits/${X1}/pulls`]: [],
    'POST /git/refs': {},
    'GET /': { node_id: 'R_1' },
    'POST /graphql': graphqlOk,
    'POST /issues': { html_url: 'https://github.com/acme/app/issues/9', number: 9 },
    ...extra,
  });
  const statusPosts = (calls: Call[]) =>
    calls.filter((c) => c.key.startsWith('POST /statuses/')).map((c) => [c.key.slice(-40), (c.body as { state: string }).state]);

  it('a second quick push does not hide the first: both are reset (H2)', async () => {
    const { client, calls } = fakeClient(history(X2));
    const res = await guardBranch('main', client, { guardLogin: GUARD, push: { sender: 'mallory', before: X1, after: X2 } });
    const gql = calls.find((c) => c.key === 'POST /graphql')!.body as { variables: { updates: unknown[] } };
    expect(gql.variables.updates).toEqual([{ name: 'refs/heads/main', beforeOid: X2, afterOid: A, force: true }]);
    expect(res.violations).toBe(2);
    expect(titles(calls)).toEqual([`vcs-protection: direct-push on main (${X2.slice(0, 7)})`]);
  });

  it('keeps a reviewed merge on top of an unreviewed commit and reports the commit (with revert steps)', async () => {
    const merged = pr({ merge_commit_sha: X2 });
    const { client, calls } = fakeClient(
      history(X2, [merged], {
        'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED'), review(2, 'carol', 'APPROVED')],
        'GET /collaborators/bob/permission': { permission: 'write' },
        'GET /collaborators/carol/permission': { permission: 'admin' },
        [`POST /statuses/${X2}`]: {},
        [`POST /statuses/${X1}`]: {},
      }),
    );
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(false);
    expect(statusPosts(calls)).toEqual([
      [X2, 'success'],
      [X1, 'failure'],
    ]);
    const body = (calls.find((c) => c.key === 'POST /issues')!.body as { body: string }).body;
    expect(body).toContain(`git revert ${X1}`);
    expect(res.lines.join('\n')).toContain('reviewed changes were merged on top of it');
  });

  it('ignores approvals from people without write access (H4)', async () => {
    const merged = pr({ merge_commit_sha: X2 });
    const { client, calls } = fakeClient(
      history(X2, [merged], {
        [`GET /commits/${X1}/statuses`]: accepted, // walk stops at X1
        'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED'), review(2, 'stranger', 'APPROVED'), review(3, 'bob', 'COMMENTED')],
        'GET /collaborators/bob/permission': { permission: 'write' },
        // 'stranger' is not a collaborator: 404
      }),
    );
    await guardBranch('main', client, { guardLogin: GUARD });
    expect(titles(calls)).toEqual([`vcs-protection: insufficient-approvals on main (${X2.slice(0, 7)})`]);
    expect(calls.filter((c) => c.key === 'GET /collaborators/bob/permission')).toHaveLength(1); // cached
  });

  it('stops at the first accepted commit and does nothing more', async () => {
    const { client, calls } = fakeClient(history(X2, [], { [`GET /commits/${X2}/statuses`]: accepted }));
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('does not trust an accepted status posted by anyone but the guard account', async () => {
    const forged = marker('main', 'success', 'mallory');
    const { client, calls } = fakeClient(history(X2, [], { [`GET /commits/${X2}/statuses`]: forged }));
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(2);
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(true);
  });

  it('opens no second issue for violations it already reported', async () => {
    const reported = marker('main', 'failure');
    const reportOnly = { ...RULES, github: { enforcement: 'report' } };
    const { client, calls } = fakeClient(
      history(X2, [], {
        [`GET /commits/${X2}/statuses`]: reported,
        [`GET /commits/${X1}/statuses`]: reported,
        [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(reportOnly),
        [`POST /statuses/${X2}`]: {},
        [`POST /statuses/${X1}`]: {},
      }),
    );
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(2);
    expect(titles(calls)).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------

describe('handleDeleteEvent', () => {
  const cfg = defaultConfig(['main', 'release/*']);
  const del = { ref: 'release/1', ref_type: 'branch' as const, sender: { login: 'mallory' } };
  const activity = 'GET /activity?ref=refs%2Fheads%2Frelease%2F1&activity_type=branch_deletion';

  it('restores the branch at the deleted tip from the activity API', async () => {
    const { client, calls } = fakeClient({
      [activity]: [{ before: AFTER, actor: { login: 'mallory' } }],
      'POST /git/refs': {},
      'POST /issues': { html_url: 'u', number: 1 },
    });
    const res = await handleDeleteEvent(del, cfg, client, 0);
    expect(calls.find((c) => c.key === 'POST /git/refs')!.body).toEqual({ ref: 'refs/heads/release/1', sha: AFTER });
    expect(res.actions[0]).toBe(`Restored 'release/1' at ${AFTER.slice(0, 7)}.`);
  });

  it('falls back to an issue whose restore command includes the bypass', async () => {
    const { client, calls } = fakeClient({ 'POST /issues': { html_url: 'u', number: 1 } });
    await handleDeleteEvent(del, cfg, client, 0);
    expect((calls.at(-1)!.body as { body: string }).body).toContain('VCS_PROTECTION_BYPASS="restore release/1" git push');
  });
});

describe('handlePrEvent', () => {
  it('posts a failure status when approvals are missing, counting only write access', async () => {
    const head = sha('3');
    const { client, calls } = fakeClient({
      'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED'), review(2, 'reader', 'APPROVED')],
      'GET /collaborators/bob/permission': { permission: 'write' },
      'GET /collaborators/reader/permission': { permission: 'read' },
      [`POST /statuses/${head}`]: {},
    });
    await handlePrEvent({ pull_request: pr({ state: 'open', merged_at: null }) }, config, client);
    expect(calls.at(-1)!.body).toMatchObject({ state: 'failure', description: '1/2 approvals: merging now will be reverted' });
  });
});

// -------------------------------------------------------------------------------------------------

const SUITE = 42;
const withPill = (pill: Partial<Config['github']['poisonPill']> = {}): Config => ({
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

const PARENT_SUITE = 1;
const onParent = (name: string, conclusion: string | null, overrides: Partial<CheckRun> = {}) =>
  check(name, conclusion, { check_suite: { id: PARENT_SUITE }, ...overrides });

describe('evaluatePoisonPill', () => {
  const facts = (checkRuns: CheckRun[], parentCheckRuns: CheckRun[] = [onParent('test', 'success')], stillOnBranch = true) => ({
    checkRuns,
    stillOnBranch,
    parentCheckRuns: [...parentCheckRuns, onParent('unit', 'success'), onParent('e2e', 'success')].filter(
      (c, i, all) => all.findIndex((x) => x.name === c.name) === i,
    ),
    parentSuiteIds: [PARENT_SUITE],
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
    const v = evaluatePoisonPill(run(), withPill(), facts(failing.checkRuns, undefined, false));
    expect(v).toMatchObject({ ok: true, reason: expect.stringContaining('no longer on') });
  });

  it('counts failure and timed_out, but not cancelled or unfinished runs, by default', () => {
    expect(evaluatePoisonPill(run(), withPill(), facts([check('test', 'cancelled')])).ok).toBe(true);
    expect(evaluatePoisonPill(run(), withPill(), facts([check('test', null, { status: 'in_progress' })])).ok).toBe(true);
    const v = evaluatePoisonPill(run(), withPill(), facts([check('unit', 'failure'), check('e2e', 'timed_out')]));
    expect(v).toMatchObject({ ok: false, kind: 'poison-pill', branch: 'main', resetAllowed: true });
    if (!v.ok) {
      expect(v.reason).toContain('unit, e2e');
      expect(v.details).toContain('`e2e`: timed_out (https://github.com/acme/app/runs/e2e)');
    }
  });

  it("only looks at the completed workflow's own checks, narrowed by `checks`", () => {
    expect(evaluatePoisonPill(run(), withPill(), facts([check('test', 'failure', { check_suite: { id: 7 } })])).ok).toBe(true);
    const mixed = facts([check('flaky-lint', 'failure'), check('test', 'success')], [onParent('flaky-lint', 'success')]);
    expect(evaluatePoisonPill(run(), withPill({ checks: ['test'] }), mixed).ok).toBe(true);
    expect(evaluatePoisonPill(run(), withPill(), mixed).ok).toBe(false);
  });

  it('does not blame a commit for checks that already failed before it landed', () => {
    const v = evaluatePoisonPill(run(), withPill(), facts([check('test', 'failure')], [onParent('test', 'failure')]));
    expect(v).toMatchObject({ ok: true, reason: expect.stringContaining(`already failed on ${BEFORE.slice(0, 7)}`) });
  });

  it('reports without a reset when the earlier result is unknown (unfinished, cancelled, missing) (M3)', () => {
    for (const prev of [onParent('test', null, { status: 'in_progress' }), onParent('test', 'cancelled')]) {
      const v = evaluatePoisonPill(run(), withPill(), facts([check('test', 'failure')], [prev]));
      expect(v).toMatchObject({ ok: false, resetAllowed: false });
    }
    const missing = { ...facts([check('test', 'failure')]), parentCheckRuns: [] };
    expect(evaluatePoisonPill(run(), withPill(), missing)).toMatchObject({ ok: false, resetAllowed: false });
  });

  it('matches earlier results only within the same workflow (L4)', () => {
    const otherWorkflow = onParent('test', 'failure', { check_suite: { id: 99 } });
    const v = evaluatePoisonPill(run(), withPill(), { ...facts([check('test', 'failure')]), parentCheckRuns: [otherWorkflow] });
    expect(v).toMatchObject({ ok: false, resetAllowed: false }); // unknown, not "inherited"
  });
});

describe('landedRange', () => {
  it('finds the commit before all the commits of a rebase-merged PR', async () => {
    const [P1, P2, BASE] = [sha('4'), sha('5'), sha('6')];
    const merged = pr({ merge_commit_sha: AFTER });
    const { client } = fakeClient({
      [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: P2 }] },
      [`GET /commits/${AFTER}/pulls`]: [merged],
      'GET /pulls/7': { ...merged, commits: 3 },
      [`GET /commits/${P2}/pulls`]: [merged],
      [`GET /commits/${P2}`]: { sha: P2, parents: [{ sha: P1 }] },
      [`GET /commits/${P1}/pulls`]: [merged],
      [`GET /commits/${P1}`]: { sha: P1, parents: [{ sha: BASE }] },
    });
    expect(await landedRange(client, AFTER, 'main')).toMatchObject({ before: BASE, parents: 1 });
  });

  it('uses the first parent of a merge commit', async () => {
    const { client } = fakeClient({
      [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: BEFORE }, { sha: sha('4') }] },
      [`GET /commits/${AFTER}/pulls`]: [pr()],
    });
    expect(await landedRange(client, AFTER, 'main')).toMatchObject({ before: BEFORE, parents: 2 });
  });
});

describe('judgeWorkflowRun', () => {
  const routes = (tip: string, parentRuns: CheckRun[] = [onParent('test', 'success')]) => ({
    'GET /git/ref/heads/main': { object: { sha: tip } },
    [`GET /compare/${AFTER}...${tip}`]: { status: 'ahead' },
    [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: BEFORE }, { sha: sha('4') }] },
    [`GET /commits/${AFTER}/pulls`]: [pr()],
    [`GET /actions/runs?head_sha=${BEFORE}`]: { workflow_runs: [{ name: 'CI', event: 'push', check_suite_id: PARENT_SUITE }] },
    [`GET /commits/${AFTER}/check-runs`]: { total_count: 1, check_runs: [check('test', 'failure')] },
    [`GET /commits/${BEFORE}/check-runs`]: { total_count: parentRuns.length, check_runs: parentRuns },
    [`GET /commits/${AFTER}/statuses`]: [],
  });

  it('turns a caused failure into a push from the commit before the merge', async () => {
    const { client } = fakeClient(routes(AFTER));
    const { verdict, push: p } = await judgeWorkflowRun({ workflow_run: run(), sender: { login: 'merger' } }, withPill(), client);
    expect(verdict).toMatchObject({ ok: false, kind: 'poison-pill', revertCommand: `git revert -m 1 ${AFTER}`, resetAllowed: true });
    expect(p).toMatchObject({ before: BEFORE, after: AFTER, sender: { login: 'merger' } });
  });

  it('skips remediation when the same check already failed before the merge', async () => {
    const { client } = fakeClient(routes(AFTER, [onParent('test', 'failure')]));
    const { verdict, push: p } = await judgeWorkflowRun({ workflow_run: run() }, withPill(), client);
    expect(verdict.ok).toBe(true);
    expect(p).toBeUndefined();
  });

  it('makes no API calls for runs it ignores', async () => {
    const { client, calls } = fakeClient({});
    expect((await judgeWorkflowRun({ workflow_run: run({ event: 'pull_request' }) }, withPill(), client)).verdict.ok).toBe(true);
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

  it('resets to the commit before the merge while it is still the tip', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': graphqlOk,
      'POST /issues': { html_url: 'u', number: 1 },
      [`POST /statuses/${AFTER}`]: {},
    });
    await remediatePush(push(), verdict, withPill(), client);
    const issue = calls.find((c) => c.key === 'POST /issues')!.body as { title: string; body: string };
    expect(issue.title).toBe(`vcs-protection: poison-pill on main (${AFTER.slice(0, 7)})`);
    expect(issue.body).toContain('broke a critical CI workflow');
    expect(issue.body).toContain('Fix the failing checks');
  });

  it('only reports, with revert steps, when the cause is uncertain', async () => {
    const { client, calls } = fakeClient({ 'POST /issues': { html_url: 'u', number: 1 }, [`POST /statuses/${AFTER}`]: {} });
    await remediatePush(push(), { ...verdict, resetAllowed: false }, withPill(), client);
    expect(calls.map((c) => c.key)).toEqual(['POST /issues', `POST /statuses/${AFTER}`]);
    expect(calls[1]!.body).toMatchObject({ context: 'vcs-protection/poison-pill', state: 'failure', description: 'reported: u' });
    expect((calls[0]!.body as { body: string }).body).toContain(`git revert -m 1 ${AFTER}`);
  });

  it('keeps newer commits and explains how to revert when the tip moved', async () => {
    const { client, calls } = fakeClient({
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': { errors: [{ message: 'ref moved' }] },
      'GET /git/ref/heads/main': { object: { sha: sha('9') } },
      'POST /issues': { html_url: 'u', number: 1 },
      [`POST /statuses/${AFTER}`]: {},
    });
    const res = await remediatePush(push(), verdict, withPill(), client);
    expect(res.actions.join('\n')).toContain('Did NOT move');
    const body = (calls.find((c) => c.key === 'POST /issues')!.body as { body: string }).body;
    expect(body).toContain(`git revert -m 1 ${AFTER}`);
    expect(body).toContain('vcs-protection/rescue/main-');
  });
});

// -------------------------------------------------------------------------------------------------

describe('ci-guard wiring', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vcsp-ci-'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function runGuard(eventName: string, event: object, routes: Record<string, Route>) {
    const { calls, fetchImpl } = fakeClient(routes);
    const file = path.join(dir, `${eventName}.json`);
    writeFileSync(file, JSON.stringify(event));
    vi.stubEnv('GITHUB_EVENT_NAME', eventName);
    vi.stubEnv('GITHUB_EVENT_PATH', file);
    vi.stubEnv('GITHUB_REPOSITORY', 'acme/app');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return { code: await ciGuard(), calls };
  }

  it('workflow_run from a pull request: exits without any API call (L5)', async () => {
    const { code, calls } = await runGuard('workflow_run', { workflow_run: run({ event: 'pull_request' }) }, {});
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('workflow_run: judges by the rules before the merge and remediates a breach', async () => {
    const rules = { ...RULES, github: { poisonPill: { enabled: true, workflows: ['CI'] } } };
    const { code, calls } = await runGuard('workflow_run', { workflow_run: run(), sender: { login: 'merger' } }, {
      [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: BEFORE }, { sha: sha('4') }] },
      [`GET /commits/${BEFORE}/statuses`]: accepted,
      [`GET /commits/${AFTER}/statuses`]: [],
      [`POST /statuses/${AFTER}`]: {},
      [`GET /contents/.vcs-protection.json?ref=${BEFORE}`]: b64(rules),
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      [`GET /commits/${AFTER}/pulls`]: [pr()],
      [`GET /actions/runs?head_sha=${BEFORE}`]: { workflow_runs: [{ name: 'CI', event: 'push', check_suite_id: PARENT_SUITE }] },
      [`GET /commits/${AFTER}/check-runs`]: { total_count: 1, check_runs: [check('test', 'failure')] },
      [`GET /commits/${BEFORE}/check-runs`]: { total_count: 1, check_runs: [onParent('test', 'success')] },
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': graphqlOk,
      'POST /issues': { html_url: 'u', number: 1 },
    });
    expect(code).toBe(1);
    expect(titles(calls)).toEqual([`vcs-protection: poison-pill on main (${AFTER.slice(0, 7)})`]);
  });

  it('push: runs the history walk from the current tip', async () => {
    const { code, calls } = await runGuard('push', push(), {
      [`GET /contents/.vcs-protection.json?ref=${BEFORE}`]: b64(RULES),
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      [`GET /commits/${AFTER}/statuses`]: [],
      [`GET /contents/.vcs-protection.json?ref=${AFTER}`]: b64(RULES),
      [`GET /commits/${AFTER}`]: { sha: AFTER, parents: [{ sha: BEFORE }] },
      [`GET /commits/${BEFORE}/statuses`]: accepted,
      [`GET /commits/${AFTER}/pulls`]: [],
      'POST /git/refs': {},
      'GET /': { node_id: 'R_1' },
      'POST /graphql': graphqlOk,
      'POST /issues': { html_url: 'u', number: 1 },
    });
    expect(code).toBe(1);
    expect(titles(calls)).toEqual([`vcs-protection: direct-push on main (${AFTER.slice(0, 7)})`]);
  });

  it('schedule: sweeps every protected branch', async () => {
    const { code, calls } = await runGuard('schedule', { schedule: '*/30 * * * *' }, {
      'GET /': { default_branch: 'main', node_id: 'R_1' },
      'GET /contents/.vcs-protection.json?ref=main': b64(RULES),
      'GET /branches': [{ name: 'main', commit: { sha: AFTER } }, { name: 'feature/x', commit: { sha: BEFORE } }],
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      [`GET /commits/${AFTER}/statuses`]: accepted,
      [`GET /contents/.vcs-protection.json?ref=${AFTER}`]: b64(RULES),
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.key.includes('feature'))).toBe(false);
  });

  it('pull_request from a fork: a 403 on the status is not an error', async () => {
    const fromFork = pr({ state: 'open', merged_at: null, head: { ref: 'f', sha: sha('3'), repo: { fork: true, full_name: 'eve/app' } } });
    const { code } = await runGuard('pull_request', { pull_request: fromFork }, {
      [`GET /commits/${BEFORE}/statuses`]: accepted,
      [`GET /contents/.vcs-protection.json?ref=${BEFORE}`]: b64(RULES),
      'GET /pulls/7/reviews': [],
      [`POST /statuses/${sha('3')}`]: reply(403, { message: 'Resource not accessible by integration' }),
    });
    expect(code).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Round 3: the trust anchor, baselines, bypass pushes, issue ordering, races and API errors.

describe('guardBranch trusts only its own per-branch markers', () => {
  const A = sha('a');
  const X1 = sha('b');
  const X2 = sha('c');

  /** Routes for unverified commits (newest first, each the parent of the previous) above anchor A. */
  function chainRoutes(tip: string[], rulesAt: Record<string, object | null>, extra: Record<string, Route> = {}) {
    const routes: Record<string, Route> = {
      'GET /git/ref/heads/main': { object: { sha: tip[0] } },
      [`GET /commits/${A}/statuses`]: accepted,
      [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(RULES),
      'POST /git/refs': {},
      'GET /': { default_branch: 'main', node_id: 'R_1' },
      'POST /graphql': graphqlOk,
      'POST /issues': { html_url: 'https://github.com/acme/app/issues/5', number: 5 },
    };
    tip.forEach((c, i) => {
      routes[`GET /commits/${c}/statuses`] = [];
      routes[`GET /commits/${c}`] = { sha: c, parents: [{ sha: tip[i + 1] ?? A }] };
      routes[`GET /commits/${c}/pulls`] = [];
      routes[`POST /statuses/${c}`] = {};
      const cfg = rulesAt[c] === undefined ? RULES : rulesAt[c];
      if (cfg) routes[`GET /contents/.vcs-protection.json?ref=${c}`] = b64(cfg);
    });
    return { ...routes, ...extra };
  }
  const resetTarget = (calls: Call[]) =>
    (calls.find((c) => c.key === 'POST /graphql')?.body as { variables: { updates: { afterOid: string }[] } } | undefined)?.variables
      .updates[0]!.afterOid;

  it('C1: a direct push that deletes the config is a violation, not the end of protection', async () => {
    const { client, calls } = fakeClient(chainRoutes([X1], { [X1]: null }));
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(1);
    expect(resetTarget(calls)).toBe(A);
    expect(res.trustedConfig?.protected[0]?.pattern).toBe('main'); // still the anchor's rules
  });

  it('C1 variant: re-adding a relaxed config on top of a deletion does not count as "introducing" the rules', async () => {
    const relaxed = { version: 1, protected: [] };
    const { client, calls } = fakeClient(chainRoutes([X2, X1], { [X2]: relaxed, [X1]: null }));
    const res = await guardBranch('main', client, { guardLogin: GUARD, push: { sender: 'mallory', before: X1, after: X2 } });
    expect(res.violations).toBe(2);
    expect(resetTarget(calls)).toBe(A);
  });

  it('C2: the sweep judges an unverified commit that unprotects main by the anchor\'s rules', async () => {
    const unprotect = { version: 1, protected: [] };
    const routes = chainRoutes([X1], { [X1]: unprotect }, { 'GET /branches': [{ name: 'main', commit: { sha: X1 } }] });
    const { calls, fetchImpl } = fakeClient(routes);
    vi.stubGlobal('fetch', fetchImpl);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vcsp-c2-'));
    writeFileSync(path.join(dir, 'e.json'), JSON.stringify({ schedule: '*/30 * * * *' }));
    for (const [k, v] of Object.entries({ GITHUB_EVENT_NAME: 'schedule', GITHUB_EVENT_PATH: path.join(dir, 'e.json'), GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', GITHUB_STEP_SUMMARY: '' })) vi.stubEnv(k, v);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await ciGuard()).toBe(1);
      expect(resetTarget(calls)).toBe(A);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('M2: a marker for another branch does not stop the walk', async () => {
    const { client, calls } = fakeClient(chainRoutes([X1], {}, { [`GET /commits/${X1}/statuses`]: marker('develop') }));
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(1);
    expect(resetTarget(calls)).toBe(A);
  });

  it('H1: no marker within the walk limit means "uninitialised": nothing is accepted', async () => {
    const commits = Array.from({ length: 110 }, (_, i) => `${i}`.padStart(40, 'f'));
    const routes = chainRoutes(commits, {});
    const { client, calls } = fakeClient(routes);
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.uninitialised).toBe(true);
    expect(res.lines[0]).toContain('run the guard once with baseline');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('M1: a push whose tip moved on is not baselined either', async () => {
    const commits = Array.from({ length: 110 }, (_, i) => `${i}`.padStart(40, 'e'));
    const { client, calls } = fakeClient(chainRoutes(commits, {}));
    const res = await guardBranch('main', client, { guardLogin: GUARD, push: { sender: 'x', before: commits[2]!, after: commits[1]! } });
    expect(res.uninitialised).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('bootstrap: the push that introduces the rules on a never-verified branch sets the baseline', async () => {
    const B0 = sha('9');
    const { client, calls } = fakeClient({
      'GET /git/ref/heads/main': { object: { sha: X1 } },
      [`GET /commits/${X1}/statuses`]: [],
      [`GET /commits/${X1}`]: { sha: X1, parents: [{ sha: B0 }] },
      [`GET /contents/.vcs-protection.json?ref=${X1}`]: b64(RULES),
      [`GET /commits/${B0}/statuses`]: [],
      [`GET /commits/${B0}`]: { sha: B0, parents: [] },
      [`POST /statuses/${X1}`]: {},
    });
    const res = await guardBranch('main', client, { guardLogin: GUARD, push: { sender: 'lead', before: B0, after: X1 } });
    expect(res.lines[0]).toContain('baseline set');
    expect(calls.at(-1)!.body).toMatchObject({ state: 'success', context: 'vcs-protection/accepted/main' });
  });

  it('H2: the sweep keeps a [skip ci] commit pushed by a bypass user (found in the activity log)', async () => {
    const withBot = { ...RULES, github: { bypassUsers: ['release-bot'] } };
    const { client, calls } = fakeClient(
      chainRoutes([X1], { [X1]: withBot }, {
        [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(withBot),
        'GET /activity?ref=refs%2Fheads%2Fmain&activity_type=push': [{ before: A, after: X1, actor: { login: 'release-bot' } }],
      }),
    );
    const res = await guardBranch('main', client, { guardLogin: GUARD });
    expect(res.violations).toBe(0);
    expect(res.lines[0]).toContain('release-bot is in github.bypassUsers');
    expect(calls.some((c) => c.key === 'POST /graphql' || c.key === 'POST /issues')).toBe(false);
  });

  it('M3: markers are written only after the issue exists', async () => {
    const report = { ...RULES, github: { enforcement: 'report' } };
    const failing = chainRoutes([X1], {}, { [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(report), 'POST /issues': reply(500) });
    const { client, calls } = fakeClient(failing);
    await expect(guardBranch('main', client, { guardLogin: GUARD })).rejects.toThrow(/500/);
    expect(calls.some((c) => c.key.startsWith('POST /statuses/'))).toBe(false);

    const disabled = chainRoutes([X1], {}, { [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(report), 'POST /issues': reply(410) });
    const second = fakeClient(disabled);
    const res = await guardBranch('main', second.client, { guardLogin: GUARD });
    const post = second.calls.find((c) => c.key === `POST /statuses/${X1}`)!;
    expect(post.body).toMatchObject({ state: 'failure', description: 'reported in the job log (issues disabled)' });
    expect(res.lines.join('\n')).toContain('issues are disabled');
  });

  it('M6: no issue when another run reported the violation in the meantime', async () => {
    let reads = 0;
    const report = { ...RULES, github: { enforcement: 'report' } };
    const routes = chainRoutes([X1], {}, {
      [`GET /contents/.vcs-protection.json?ref=${A}`]: b64(report),
      // First read (the walk): not reported. Second read (just before the issue): reported.
      [`GET /commits/${X1}/statuses`]: () => (reads++ === 0 ? [] : marker('main', 'failure')),
    });
    const { client, calls } = fakeClient(routes);
    await guardBranch('main', client, { guardLogin: GUARD });
    expect(titles(calls)).toEqual([]);
  });

  it('M5: waits for GitHub to link a UI merge to its PR instead of resetting it', async () => {
    let lookups = 0;
    const merged = pr({ merge_commit_sha: X1 });
    const { client, calls } = fakeClient(
      chainRoutes([X1], {}, {
        [`GET /commits/${X1}`]: { sha: X1, parents: [{ sha: A }], committer: { login: 'web-flow' } },
        [`GET /commits/${X1}/pulls`]: () => (lookups++ < 2 ? [] : [merged]),
        'GET /pulls/7/reviews': [review(1, 'bob', 'APPROVED'), review(2, 'carol', 'APPROVED')],
        'GET /collaborators/bob/permission': { permission: 'write' },
        'GET /collaborators/carol/permission': { permission: 'write' },
      }),
    );
    const res = await guardBranch('main', client, { guardLogin: GUARD, sleep: async () => {} });
    expect(res.violations).toBe(0);
    expect(lookups).toBe(3);
    expect(calls.some((c) => c.key === 'POST /graphql')).toBe(false);
  });
});

describe('poison pill: reported once (M4)', () => {
  it('skips a commit the poison pill already reported', async () => {
    const reported = [{ state: 'failure', context: 'vcs-protection/poison-pill', description: 'r', creator: { login: GUARD } }];
    const { client, calls } = fakeClient({ [`GET /commits/${AFTER}/statuses`]: reported });
    const cfg = { ...config, github: { ...config.github, poisonPill: { ...config.github.poisonPill, enabled: true, workflows: ['CI'] } } };
    const run: WorkflowRun = { id: 1, name: 'CI', event: 'push', head_branch: 'main', head_sha: AFTER, conclusion: 'failure', check_suite_id: 1, html_url: 'u' };
    const res = await judgeWorkflowRun({ workflow_run: run }, cfg, client, GUARD);
    expect(res.verdict).toMatchObject({ ok: true, reason: expect.stringContaining('already reported') });
    expect(calls).toHaveLength(1);
  });
});

describe('updateRefAtomic error handling', () => {
  const base = { 'GET /': { node_id: 'R_1' } };
  it('an error after the update was applied counts as success', async () => {
    const { client } = fakeClient({ ...base, 'POST /graphql': reply(502), 'GET /git/ref/heads/main': { object: { sha: BEFORE } } });
    expect(await client.updateRefAtomic('main', AFTER, BEFORE)).toEqual({ ok: true });
  });

  it('a transient error with nothing applied is rethrown', async () => {
    const { client } = fakeClient({ ...base, 'POST /graphql': reply(502), 'GET /git/ref/heads/main': { object: { sha: AFTER } } });
    await expect(client.updateRefAtomic('main', AFTER, BEFORE)).rejects.toThrow(/502/);
  });

  it('a validation error mentioning RefUpdate does not switch to the non-atomic fallback', async () => {
    const { client, calls } = fakeClient({
      ...base,
      'POST /graphql': { errors: [{ message: 'Variable $updates of type [RefUpdate!]! was provided invalid value' }] },
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
    });
    await expect(client.updateRefAtomic('main', AFTER, BEFORE)).rejects.toThrow(/invalid value/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('ci-guard: baseline, new branches, fork 403s', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vcsp-r3-'));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function runGuard(eventName: string, event: object, routes: Record<string, Route>) {
    const { calls, fetchImpl } = fakeClient(routes);
    const file = path.join(dir, `${eventName}.json`);
    writeFileSync(file, JSON.stringify(event));
    for (const [k, v] of Object.entries({ GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: 'acme/app', GITHUB_TOKEN: 't', GITHUB_STEP_SUMMARY: '', GITHUB_ACTOR: 'lead' })) vi.stubEnv(k, v);
    vi.stubGlobal('fetch', fetchImpl);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return { run: () => ciGuard(), calls };
  }

  it('Run workflow with baseline marks the tip of the default branch and of each protected branch', async () => {
    const rules = { version: 1, protected: [{ pattern: 'main' }, { pattern: 'release/*' }] };
    const { run, calls } = await runGuard('workflow_dispatch', { inputs: { baseline: true } }, {
      'GET /': { default_branch: 'main', node_id: 'R' },
      'GET /git/ref/heads/main': { object: { sha: AFTER } },
      'GET /git/ref/heads/release/1': { object: { sha: BEFORE } },
      [`GET /contents/.vcs-protection.json?ref=${AFTER}`]: b64(rules),
      'GET /branches': [{ name: 'main' }, { name: 'release/1' }, { name: 'feature/x' }],
      [`POST /statuses/${AFTER}`]: {},
      [`POST /statuses/${BEFORE}`]: {},
    });
    expect(await run()).toBe(0);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => (c.body as { context: string; description: string }));
    expect(posts).toEqual([
      expect.objectContaining({ context: 'vcs-protection/accepted/main', description: 'baseline by @lead' }),
      expect.objectContaining({ context: 'vcs-protection/accepted/release/1' }),
    ]);
  });

  it('a new protected branch created from verified history gets its own marker', async () => {
    const M = sha('d');
    const rules = { version: 1, protected: [{ pattern: 'main' }, { pattern: 'release/*' }] };
    const { run, calls } = await runGuard('push', push({ ref: 'refs/heads/release/2', created: true, before: sha('0') }), {
      'GET /': { default_branch: 'main', node_id: 'R' },
      'GET /git/ref/heads/main': { object: { sha: M } },
      [`GET /commits/${M}/statuses`]: accepted,
      [`GET /contents/.vcs-protection.json?ref=${M}`]: b64(rules),
      [`GET /commits/${AFTER}/statuses`]: [],
      [`GET /compare/main...${AFTER}`]: { status: 'behind' },
      [`POST /statuses/${AFTER}`]: {},
    });
    expect(await run()).toBe(0);
    expect(calls.at(-1)!.body).toMatchObject({ context: 'vcs-protection/accepted/release/2', state: 'success' });
  });

  it('a 403 on a PR from the same repository is a real error', async () => {
    const { run } = await runGuard('pull_request', { pull_request: pr({ state: 'open', merged_at: null, head: { ref: 'f', sha: sha('3'), repo: { fork: false, full_name: 'acme/app' } } }) }, {
      [`GET /commits/${BEFORE}/statuses`]: accepted,
      [`GET /contents/.vcs-protection.json?ref=${BEFORE}`]: b64(RULES),
      'GET /pulls/7/reviews': [],
      [`POST /statuses/${sha('3')}`]: reply(403, { message: 'Resource not accessible by integration' }),
    });
    await expect(run()).rejects.toThrow(/403/);
  });
});
