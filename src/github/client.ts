import { spawnSync } from 'node:child_process';
import { apiBase, type GitHubRepo } from './remote.js';

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Token lookup order: GITHUB_TOKEN, GH_TOKEN, then the GitHub CLI (`gh auth token`). */
export function resolveToken(): string | null {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const res = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true });
    const token = res.status === 0 ? res.stdout.trim() : '';
    return token || null;
  } catch {
    return null;
  }
}

export type Fetch = typeof fetch;

/** Minimal GitHub REST client (just the endpoints this package needs). */
export class GitHubClient {
  private base: string;

  constructor(
    public repo: GitHubRepo,
    private token: string,
    private fetchImpl: Fetch = fetch,
  ) {
    this.base = `${apiBase(repo)}/repos/${repo.owner}/${repo.repo}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'vcs-protection',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(`GitHub API ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** GET every page of a list endpoint. */
  async paginate<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 20; page++) {
      const batch = await this.request<T[]>('GET', `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  pullsForCommit(sha: string) {
    return this.request<PullRequest[]>('GET', `/commits/${sha}/pulls`);
  }

  getPull(num: number) {
    return this.request<PullRequest>('GET', `/pulls/${num}`);
  }

  reviews(num: number) {
    return this.paginate<Review>(`/pulls/${num}/reviews`);
  }

  async fileAt(filePath: string, ref: string): Promise<string | null> {
    try {
      const res = await this.request<{ content?: string; encoding?: string }>(
        'GET',
        `/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
      );
      if (!res.content) return null;
      return Buffer.from(res.content, (res.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async getRefSha(branch: string): Promise<string | null> {
    try {
      const res = await this.request<{ object: { sha: string } }>('GET', `/git/ref/heads/${branch}`);
      return res.object.sha;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  createRef(branch: string, sha: string) {
    return this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  }

  updateRef(branch: string, sha: string, force: boolean) {
    return this.request('PATCH', `/git/refs/heads/${branch}`, { sha, force });
  }

  deleteRef(branch: string) {
    return this.request('DELETE', `/git/refs/heads/${branch}`);
  }

  compare(base: string, head: string) {
    return this.request<{ status: 'ahead' | 'behind' | 'identical' | 'diverged' }>(
      'GET',
      `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
  }

  createIssue(title: string, body: string) {
    return this.request<{ html_url: string; number: number }>('POST', '/issues', { title, body });
  }

  createStatus(sha: string, state: 'success' | 'failure' | 'pending' | 'error', description: string, context: string) {
    return this.request('POST', `/statuses/${sha}`, { state, description: description.slice(0, 140), context });
  }

  createPull(title: string, head: string, base: string, body: string) {
    return this.request<{ html_url: string }>('POST', '/pulls', { title, head, base, body });
  }

  getRepo() {
    return this.request<{ default_branch: string }>('GET', '');
  }
}

export interface PullRequest {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

export interface Review {
  id: number;
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
  commit_id?: string;
}
