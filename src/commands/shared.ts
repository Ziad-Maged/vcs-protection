import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { loadConfig, localConfigPath, type LoadedConfig } from '../config/load.js';
import { parseConfig, serializeConfig, type Config } from '../config/schema.js';
import { GitHubClient, resolveToken } from '../github/client.js';
import { parseGitHubRemote } from '../github/remote.js';
import { renderWorkflow, WORKFLOW_PATH } from '../github/workflow.js';
import { remoteUrl, requireRepoRoot } from '../git/repo.js';
import { VERSION } from '../version.js';

export function requireLocalConfig(): { file: string; config: Config } {
  const file = localConfigPath();
  if (!file || !existsSync(file)) {
    throw new Error('No .vcs-protection.json in this repository. Run `vcs-protection init` first.');
  }
  return { file, config: parseConfig(readFileSync(file, 'utf8'), file) };
}

export function requireEffectiveConfig(): LoadedConfig {
  const loaded = loadConfig();
  if (!loaded) throw new Error('No vcs-protection config found. Run `vcs-protection init` first.');
  return loaded;
}

/** The working-tree config if there is one (the version being edited), else the effective rules. */
export function workingConfig(): Config {
  const file = localConfigPath();
  if (file && existsSync(file)) return parseConfig(readFileSync(file, 'utf8'), file);
  return requireEffectiveConfig().config;
}

export function writeConfig(file: string, config: Config): void {
  writeFileSync(file, serializeConfig(config));
}

/** Compare file contents ignoring line endings (a checkout with core.autocrlf=true has CRLF). */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

export function workflowFile(): string {
  return path.join(requireRepoRoot(), WORKFLOW_PATH);
}

export function writeWorkflow(config: Config, version = VERSION): string {
  const file = workflowFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderWorkflow(config, version));
  return file;
}

export function githubClient(config: Config): GitHubClient | null {
  const url = remoteUrl(config.remote);
  const repo = url ? parseGitHubRemote(url) : null;
  const token = resolveToken();
  return repo && token ? new GitHubClient(repo, token) : null;
}

export async function prompt(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (${fallback}): `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}
