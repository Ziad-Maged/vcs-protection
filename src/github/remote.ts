export interface GitHubRepo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Parse a GitHub remote URL. Supports:
 *   https://github.com/owner/repo(.git)
 *   git@github.com:owner/repo(.git)
 *   ssh://git@github.com/owner/repo(.git)
 * Returns null for anything that does not look like a GitHub URL.
 */
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m && m[1] && m[2] && m[3] && /github/i.test(m[1])) {
      return { host: m[1].toLowerCase(), owner: m[2], repo: m[3] };
    }
  }
  return null;
}

export function webUrl(r: GitHubRepo): string {
  return `https://${r.host}/${r.owner}/${r.repo}`;
}

export function compareUrl(r: GitHubRepo, base: string, head: string): string {
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `${webUrl(r)}/compare/${enc(base)}...${enc(head)}?expand=1`;
}

export function apiBase(r: GitHubRepo): string {
  return r.host === 'github.com' ? 'https://api.github.com' : `https://${r.host}/api/v3`;
}
