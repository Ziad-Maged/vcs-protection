import { appendFileSync, readFileSync } from 'node:fs';
import { CONFIG_FILE, parseConfig, type Config } from '../config/schema.js';
import { GitHubClient, GitHubError, resolveToken } from '../github/client.js';
import {
  acceptCreatedBranch,
  baselineBranch,
  baselineHint,
  DEFAULT_GUARD_LOGIN,
  guardBranch,
  handleDeleteEvent,
  handlePrEvent,
  judgePush,
  judgeWorkflowRun,
  landedRange,
  poisonPillPrecheck,
  remediatePush,
  trustedConfigFor,
  type DeleteEvent,
  type PrEvent,
  type PushEvent,
  type WorkflowRunEvent,
} from '../github/guard.js';
import type { GitHubRepo } from '../github/remote.js';
import { ruleFor } from '../rules/match.js';
import { info } from '../ui.js';

/** Env var the generated workflow sets: whose statuses the guard trusts (never read from commits). */
export const GUARD_LOGIN_ENV = 'VCS_PROTECTION_GUARD_LOGIN';

function summary(lines: string[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, lines.join('\n') + '\n');
  for (const l of lines) info(l);
}

const isZero = (sha: string) => /^0+$/.test(sha);

/** The default branch's trusted rules (the config at its newest verified commit). */
async function defaultBranchRules(client: GitHubClient, guardLogin: string): Promise<{ branch: string; config: Config | null }> {
  const { default_branch } = await client.getRepo();
  const tip = await client.getRefSha(default_branch);
  const trusted = await trustedConfigFor(client, default_branch, tip, guardLogin);
  return { branch: default_branch, config: trusted?.config ?? null };
}

/**
 * The sweep (schedule, or Run workflow). Judges the default branch first: its trusted rules then
 * say which other branches are protected. With `baseline`, marks the current tips as verified.
 */
async function sweep(client: GitHubClient, guardLogin: string, baseline: boolean): Promise<number> {
  const { default_branch } = await client.getRepo();

  if (baseline) {
    // An explicit request by someone who can run workflows. No verified commit exists yet (or it
    // is lost), so the list of branches comes from the default branch's current config.
    const tip = await client.getRefSha(default_branch);
    const raw = tip ? await client.fileAt(CONFIG_FILE, tip) : null;
    const config = raw ? parseConfig(raw, `${CONFIG_FILE}@${default_branch}`) : null;
    const lines = [await baselineBranch(client, default_branch, process.env.GITHUB_ACTOR)];
    for (const b of await client.listBranches()) {
      if (b.name !== default_branch && config && ruleFor(config, b.name)) {
        lines.push(await baselineBranch(client, b.name, process.env.GITHUB_ACTOR));
      }
    }
    summary(lines);
    return 0;
  }

  const main = await guardBranch(default_branch, client, { guardLogin });
  summary(main.lines);
  let failed = !!(main.uninitialised || main.issueUrl || main.reset);
  const rules = main.trustedConfig;
  if (!rules) {
    if (!main.uninitialised) summary([`No trusted ${CONFIG_FILE} on '${default_branch}'; nothing else to enforce.`]);
    return failed ? 1 : 0;
  }
  for (const b of await client.listBranches()) {
    if (b.name === default_branch || !ruleFor(rules, b.name)) continue;
    const res = await guardBranch(b.name, client, { guardLogin });
    summary(res.lines);
    if (res.uninitialised || res.issueUrl || res.reset) failed = true;
  }
  return failed ? 1 : 0;
}

/** Entry point used by the GitHub Actions workflow. Returns the process exit code. */
export async function ciGuard(): Promise<number> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventName || !eventPath || !repository) {
    throw new Error('ci-guard must run inside GitHub Actions (GITHUB_EVENT_NAME/GITHUB_EVENT_PATH/GITHUB_REPOSITORY).');
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  // Cheap exits first: a workflow_run from a pull request never needs the API.
  if (eventName === 'workflow_run' && (event as WorkflowRunEvent).workflow_run?.event !== 'push') {
    summary([`Poison pill: ignoring a run triggered by '${(event as WorkflowRunEvent).workflow_run?.event}', not by a push.`]);
    return 0;
  }
  const token = resolveToken();
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  const [owner, repo] = repository.split('/') as [string, string];
  const host = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/^https?:\/\//, '');
  const gh: GitHubRepo = { host, owner, repo };
  const client = new GitHubClient(gh, token, fetch, {
    api: process.env.GITHUB_API_URL || undefined,
    graphql: process.env.GITHUB_GRAPHQL_URL || undefined,
  });
  // Whose markers count comes from the workflow, never from the commits being judged.
  const guardLogin = process.env[GUARD_LOGIN_ENV] || DEFAULT_GUARD_LOGIN;

  if (eventName === 'push') {
    const push = event as PushEvent;
    if (!push.ref.startsWith('refs/heads/')) {
      summary([`Ignoring ${push.ref}: not a branch.`]);
      return 0;
    }
    const branch = push.ref.slice('refs/heads/'.length);
    // The rules come from the newest verified commit: below `before` for an existing branch,
    // the default branch's for a new one. Never from the pushed commits or an unverified `before`.
    const created = push.created || isZero(push.before);
    const trusted = created
      ? (await defaultBranchRules(client, guardLogin)).config
      : ((await trustedConfigFor(client, branch, push.before, guardLogin))?.config ?? null);

    if (trusted) {
      if (!ruleFor(trusted, branch)) {
        summary([`✅ ${push.ref}: '${branch}' is not protected`]);
        return 0;
      }
      const verdict = await judgePush(push, trusted, client, guardLogin);
      if (!verdict.ok) {
        const result = await remediatePush(push, verdict, trusted, client);
        summary([`❌ ${verdict.reason}`, ...result.actions.map((a) => `- ${a}`)]);
        return 1;
      }
      if (push.deleted) {
        summary([`✅ ${push.ref}: ${verdict.reason}`]);
        return 0;
      }
      if (created && verdict.reason !== 'initial branch') {
        // A new protected branch from verified history: give it its own anchor.
        await acceptCreatedBranch(client, branch, push.after, verdict.reason);
        summary([`✅ ${push.ref}: ${verdict.reason}`]);
        return 0;
      }
    }
    // Judge the whole unverified history up to the current tip, including pushes whose own run
    // was skipped or cancelled. Without trusted rules this is either the push that introduces
    // them (baseline) or an uninitialised branch.
    const res = await guardBranch(branch, client, {
      guardLogin,
      push: { sender: push.sender?.login, before: push.before, after: push.after },
    });
    summary(res.lines);
    return res.uninitialised || res.issueUrl || res.reset ? 1 : 0;
  }

  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    const input = (event as { inputs?: { baseline?: unknown } }).inputs?.baseline;
    return sweep(client, guardLogin, eventName === 'workflow_dispatch' && (input === true || input === 'true'));
  }

  if (eventName === 'delete') {
    const del = event as DeleteEvent;
    const { config } = await defaultBranchRules(client, guardLogin);
    if (!config) return 0;
    const result = await handleDeleteEvent(del, config, client);
    if (result.actions.length) summary(result.actions);
    return result.issueUrl ? 1 : 0;
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_review') {
    const pr = event as PrEvent;
    const config = (await trustedConfigFor(client, pr.pull_request.base.ref, pr.pull_request.base.sha, guardLogin))?.config;
    if (!config) return 0;
    try {
      const check = await handlePrEvent(pr, config, client);
      if (check) summary([`PR #${pr.pull_request.number}: ${check.description}${check.ok ? '' : ' (not enough to merge)'}`]);
    } catch (err) {
      // Pull requests from forks get a read-only token: no status can be posted. Not an error.
      const head = pr.pull_request.head.repo;
      const fromFork = !!head && (head.fork || head.full_name !== repository);
      if (!(err instanceof GitHubError && err.status === 403 && fromFork)) throw err;
      summary([`PR #${pr.pull_request.number}: could not post the approvals status (read-only token for a fork).`]);
    }
    // Informational only: a failing status is enough, the job itself succeeds.
    return 0;
  }

  if (eventName === 'workflow_run') {
    const wr = event as WorkflowRunEvent;
    const run = wr.workflow_run;
    const branch = run.head_branch;
    if (!branch) return 0;
    // Judge by the trusted rules before the change landed, so a breaking commit can't switch the
    // poison pill off.
    const range = await landedRange(client, run.head_sha, branch);
    const config = range ? ((await trustedConfigFor(client, branch, range.before, guardLogin))?.config ?? null) : null;
    if (!config) {
      summary([range ? `❌ ${baselineHint(branch)}` : `Poison pill: ${run.head_sha.slice(0, 7)} has no parent; nothing to do.`]);
      return range ? 1 : 0;
    }
    const pre = poisonPillPrecheck(run, config);
    if (pre.ok) {
      summary([`Poison pill: ignoring '${run.name}' on ${branch}: ${pre.verdict.reason}.`]);
      return 0;
    }
    const { verdict, push } = await judgeWorkflowRun(wr, config, client, guardLogin);
    if (verdict.ok || !push) {
      summary([`✅ ${branch}: ${verdict.reason}`]);
      return 0;
    }
    const result = await remediatePush(push, verdict, config, client);
    summary([`❌ ${verdict.reason}`, ...(verdict.details ?? []).map((d) => `  - ${d}`), ...result.actions.map((a) => `- ${a}`)]);
    return 1;
  }

  summary([`Ignoring event '${eventName}'.`]);
  return 0;
}
