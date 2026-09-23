import { appendFileSync, readFileSync } from 'node:fs';
import { CONFIG_FILE, parseConfig, type Config } from '../config/schema.js';
import { GitHubClient, resolveToken } from '../github/client.js';
import {
  handleDeleteEvent,
  handlePrEvent,
  judgePush,
  remediatePush,
  type DeleteEvent,
  type PrEvent,
  type PushEvent,
} from '../github/guard.js';
import type { GitHubRepo } from '../github/remote.js';
import { info } from '../ui.js';

async function configAt(client: GitHubClient, ref: string): Promise<Config | null> {
  const raw = await client.fileAt(CONFIG_FILE, ref);
  return raw === null ? null : parseConfig(raw, `${CONFIG_FILE}@${ref}`);
}

function summary(lines: string[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, lines.join('\n') + '\n');
  for (const l of lines) info(l);
}

/** Entry point used by the GitHub Actions workflow. Returns the process exit code. */
export async function ciGuard(): Promise<number> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!eventName || !eventPath || !repository) {
    throw new Error('ci-guard must run inside GitHub Actions (GITHUB_EVENT_NAME/GITHUB_EVENT_PATH/GITHUB_REPOSITORY).');
  }
  const token = resolveToken();
  if (!token) throw new Error('GITHUB_TOKEN is not set.');
  const [owner, repo] = repository.split('/') as [string, string];
  const host = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/^https?:\/\//, '');
  const gh: GitHubRepo = { host, owner, repo };
  const client = new GitHubClient(gh, token);
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));

  if (eventName === 'push') {
    const push = event as PushEvent;
    // Judge the push against the rules as they were BEFORE it, so a push can't disable its own check.
    const ref = /^0+$/.test(push.before) ? (push.repository?.default_branch ?? push.after) : push.before;
    const config = await configAt(client, ref);
    if (!config) {
      summary([`No ${CONFIG_FILE} at ${ref}; nothing to enforce.`]);
      return 0;
    }
    const verdict = await judgePush(push, config, client);
    if (verdict.ok) {
      summary([`✅ ${push.ref}: ${verdict.reason}`]);
      return 0;
    }
    const result = await remediatePush(push, verdict, config, client);
    summary([`❌ ${verdict.reason}`, ...result.actions.map((a) => `- ${a}`)]);
    return 1;
  }

  if (eventName === 'delete') {
    const del = event as DeleteEvent & { repository?: { default_branch?: string } };
    const config = await configAt(client, del.repository?.default_branch ?? 'HEAD');
    if (!config) return 0;
    const result = await handleDeleteEvent(del, config, client);
    if (result.actions.length) summary(result.actions);
    return result.issueUrl ? 1 : 0;
  }

  if (eventName === 'pull_request' || eventName === 'pull_request_review') {
    const pr = event as PrEvent;
    const config = await configAt(client, pr.pull_request.base.sha);
    if (!config) return 0;
    const check = await handlePrEvent(pr, config, client);
    if (check) summary([`PR #${pr.pull_request.number}: ${check.description}${check.ok ? '' : ' (not enough to merge)'}`]);
    // Informational only: a failing status is enough, the job itself succeeds.
    return 0;
  }

  summary([`Ignoring event '${eventName}'.`]);
  return 0;
}
