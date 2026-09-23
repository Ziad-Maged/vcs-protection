import type { Config } from '../config/schema.js';
import { parseGitHubRemote, type GitHubRepo } from '../github/remote.js';
import { remoteUrl } from '../git/repo.js';

export const BYPASS_ENV = 'VCS_PROTECTION_BYPASS';

export function bypassReason(): string | undefined {
  return process.env[BYPASS_ENV];
}

export function githubRepoFor(config: Config, cwd?: string): GitHubRepo | null {
  const url = remoteUrl(config.remote, cwd);
  return url ? parseGitHubRemote(url) : null;
}

/** Read all of stdin (hooks such as reference-transaction and pre-push receive data there). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
