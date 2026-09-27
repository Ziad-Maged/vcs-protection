import { spawnSync } from 'node:child_process';
import { apiBase, type GitHubRepo } from './remote.js';

export class GitHubError extends Error {
  /** GraphQL error codes (`extensions.code`), when the error came from GraphQL. */
  codes: string[] = [];
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** The GraphQL schema has no `updateRefs` mutation (older GitHub Enterprise Server). */
function mutationMissing(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false;
  return err.codes.includes('undefinedField') || /Field 'updateRefs' doesn't exist on type 'Mutation'/.test(err.message);
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

/** Encode a branch name for a REST path, one segment at a time (keeps the slashes). */
export const encRef = (name: string) => name.split('/').map(encodeURIComponent).join('/');

export const ZERO_OID = '0'.repeat(40);

/** Repository roles that may approve pull requests (GitHub maps "maintain" to "write"). */
const APPROVER_PERMISSIONS = new Set(['admin', 'write', 'maintain']);

/** Where the API lives, when it isn't derivable from the host (GitHub Actions sets both). */
export interface ApiUrls {
  /** REST base, e.g. `GITHUB_API_URL` (https://api.github.com, https://api.<tenant>.ghe.com, …). */
  api?: string;
  /** GraphQL endpoint, e.g. `GITHUB_GRAPHQL_URL`. */
  graphql?: string;
}

/** Minimal GitHub REST client (just the endpoints this package needs). */
export class GitHubClient {
  private base: string;
  private graphqlUrl: string;
  private permissionCache = new Map<string, boolean>();
  private repoNodeId: string | null = null;

  constructor(
    public repo: GitHubRepo,
    private token: string,
    private fetchImpl: Fetch = fetch,
    urls: ApiUrls = {},
  ) {
    const api = (urls.api ?? apiBase(repo)).replace(/\/+$/, '');
    this.base = `${api}/repos/${repo.owner}/${repo.repo}`;
    this.graphqlUrl = urls.graphql ?? (api.endsWith('/api/v3') ? api.replace(/\/api\/v3$/, '/api/graphql') : `${api}/graphql`);
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
      const res = await this.request<{ object: { sha: string } }>('GET', `/git/ref/heads/${encRef(branch)}`);
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
    return this.request('PATCH', `/git/refs/heads/${encRef(branch)}`, { sha, force });
  }

  deleteRef(branch: string) {
    return this.request('DELETE', `/git/refs/heads/${encRef(branch)}`);
  }

  compare(base: string, head: string) {
    return this.request<{ status: 'ahead' | 'behind' | 'identical' | 'diverged'; commits?: { sha: string }[] }>(
      'GET',
      `/compare/${encRef(base)}...${encRef(head)}`,
    );
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request<{ data?: T; errors?: { message: string; extensions?: { code?: string } }[] }>(
      'POST',
      this.graphqlUrl,
      { query, variables },
    );
    if (res.errors?.length) {
      const err = new GitHubError(`GitHub GraphQL: ${res.errors.map((e) => e.message).join('; ')}`, 400);
      err.codes = res.errors.map((e) => e.extensions?.code ?? '');
      throw err;
    }
    return res.data as T;
  }

  /**
   * Move (or delete, with newSha null) a branch only if it still points at `expectedSha`: a real
   * compare-and-swap through the GraphQL `updateRefs` mutation. Returns false if the branch had
   * moved. Where the mutation is unavailable (older GitHub Enterprise), falls back to reading the
   * ref and then writing it, and says so in the returned `note`.
   */
  async updateRefAtomic(branch: string, expectedSha: string, newSha: string | null): Promise<{ ok: boolean; note?: string }> {
    try {
      if (!this.repoNodeId) this.repoNodeId = (await this.getRepo()).node_id;
      await this.graphql(
        'mutation($repo: ID!, $updates: [RefUpdate!]!) { updateRefs(input: { repositoryId: $repo, refUpdates: $updates }) { clientMutationId } }',
        {
          repo: this.repoNodeId,
          updates: [{ name: `refs/heads/${branch}`, beforeOid: expectedSha, afterOid: newSha ?? ZERO_OID, force: true }],
        },
      );
      return { ok: true };
    } catch (err) {
      if (!mutationMissing(err)) {
        // Refused, failed, or failed after applying: the ref itself says which.
        const now = await this.getRefSha(branch);
        if (now === (newSha ?? null)) return { ok: true }; // it was applied
        if (now === expectedSha) throw err; // nothing happened: a real (possibly transient) error
        return { ok: false }; // someone moved the branch
      }
    }
    // Fallback: not atomic.
    if ((await this.getRefSha(branch)) !== expectedSha) return { ok: false };
    if (newSha) await this.updateRef(branch, newSha, true);
    else await this.deleteRef(branch);
    return { ok: true, note: 'GraphQL updateRefs is unavailable here; the branch was updated without an atomic check.' };
  }

  /** Whether `login` may approve pull requests here (write, maintain or admin). Cached per client. */
  async canApprove(login: string): Promise<boolean> {
    const cached = this.permissionCache.get(login);
    if (cached !== undefined) return cached;
    let ok = false;
    try {
      const res = await this.request<{ permission: string; role_name?: string }>(
        'GET',
        `/collaborators/${encodeURIComponent(login)}/permission`,
      );
      ok = APPROVER_PERMISSIONS.has(res.permission) || APPROVER_PERMISSIONS.has(res.role_name ?? '');
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 404)) throw err; // not a collaborator
    }
    this.permissionCache.set(login, ok);
    return ok;
  }

  /** Commit statuses, newest first (first page is enough to find the latest per context). */
  statuses(sha: string) {
    return this.request<CommitStatus[]>('GET', `/commits/${sha}/statuses?per_page=100`);
  }

  listBranches() {
    return this.paginate<{ name: string; commit: { sha: string } }>('/branches');
  }

  /** Most recent deletion of a branch, from the repository activity API (null if unknown). */
  async lastDeletion(branch: string): Promise<{ before: string; actor: string | null } | null> {
    try {
      const res = await this.request<{ before: string; actor: { login: string } | null }[]>(
        'GET',
        `/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=branch_deletion&per_page=1`,
      );
      const a = res[0];
      return a ? { before: a.before, actor: a.actor?.login ?? null } : null;
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  /** Recent pushes to a branch (who pushed what), from the repository activity API; [] if unavailable. */
  async branchPushes(branch: string): Promise<BranchPush[]> {
    const out: BranchPush[] = [];
    for (const type of ['push', 'force_push']) {
      try {
        const res = await this.request<{ before: string; after: string; actor: { login: string } | null }[]>(
          'GET',
          `/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=${type}&per_page=100`,
        );
        for (const a of res) out.push({ before: a.before, after: a.after, actor: a.actor?.login ?? null });
      } catch (err) {
        if (!(err instanceof GitHubError && (err.status === 404 || err.status === 403))) throw err;
      }
    }
    return out;
  }

  /** Workflow runs for a commit, to map check suites to workflow names. */
  async workflowRunsFor(sha: string): Promise<{ name: string; check_suite_id: number; event: string }[]> {
    const res = await this.request<{ workflow_runs: { name: string; check_suite_id: number; event: string }[] }>(
      'GET',
      `/actions/runs?head_sha=${sha}&per_page=100`,
    );
    return res.workflow_runs;
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

  /** Every check run on a commit. The endpoint wraps its list as `{ total_count, check_runs }`. */
  async checkRunsForCommit(sha: string): Promise<CheckRun[]> {
    const out: CheckRun[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await this.request<{ total_count: number; check_runs: CheckRun[] }>(
        'GET',
        `/commits/${sha}/check-runs?per_page=100&page=${page}`,
      );
      out.push(...res.check_runs);
      if (res.check_runs.length < 100 || out.length >= res.total_count) break;
    }
    return out;
  }

  getCommit(sha: string) {
    return this.request<{ sha: string; parents: { sha: string }[]; committer?: { login: string } | null }>('GET', `/commits/${sha}`);
  }

  getRepo() {
    return this.request<{ default_branch: string; node_id: string }>('GET', '');
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
  head: { ref: string; sha: string; repo?: { fork: boolean; full_name: string } | null };
  /** Number of commits in the PR (present on GET /pulls/{n}). */
  commits?: number;
}

export interface BranchPush {
  before: string;
  after: string;
  actor: string | null;
}

export interface CommitStatus {
  state: 'success' | 'failure' | 'pending' | 'error';
  context: string;
  description: string | null;
  creator: { login: string } | null;
}

export interface CheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null;
  html_url: string;
  check_suite?: { id: number } | null;
}

/** The `workflow_run` object of a workflow_run event. */
export interface WorkflowRun {
  id: number;
  name: string;
  /** Event that triggered the run (`push`, `pull_request`, ...). */
  event: string;
  head_branch: string | null;
  head_sha: string;
  conclusion: string | null;
  check_suite_id: number;
  html_url: string;
}

export interface Review {
  id: number;
  user: { login: string } | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
  commit_id?: string;
}
