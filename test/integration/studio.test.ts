import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = path.resolve(__dirname, '../../dist/cli.js');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vcsp-studio-'));
const repo = path.join(tmp, 'repo');
const env = {
  ...process.env,
  HOME: path.join(tmp, 'home'),
  USERPROFILE: path.join(tmp, 'home'),
  GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  NO_COLOR: '1',
  GITHUB_TOKEN: '',
  GH_TOKEN: '',
  CI: '',
};

interface Studio {
  child: ChildProcess;
  base: string;
  token: string;
  port: number;
  out: () => string;
}

/** Start `vcs-protection studio --no-open` in `cwd` and wait for the printed link. */
function startStudio(cwd: string): Promise<Studio> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'studio', '--no-open'], { cwd, env });
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?t=([\w-]+)/);
      if (m) resolve({ child, base: `http://127.0.0.1:${m[1]}`, token: m[2]!, port: Number(m[1]), out: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`studio exited (${code}): ${out}`)));
  });
}

/** Raw HTTP, so tests can send Host/Origin headers that fetch would not allow. */
function http(
  s: Studio,
  method: string,
  pathname: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: s.port, method, path: pathname, headers: { Host: `127.0.0.1:${s.port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
const api = (s: Studio, p: string, h: Record<string, string> = {}) => http(s, 'GET', p, { headers: { 'X-Studio-Token': s.token, ...h } });
const act = (s: Studio, name: string, args: object, h: Record<string, string> = {}) =>
  http(s, 'POST', `/api/actions/${name}`, {
    headers: { 'X-Studio-Token': s.token, 'Content-Type': 'application/json', ...h },
    body: JSON.stringify(args),
  });

let studio: Studio;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('Build first: npm run build');
  mkdirSync(path.join(tmp, 'home'), { recursive: true });
  writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n');
  mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo, env });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env });
  studio = await startStudio(repo);
});

afterAll(() => {
  studio?.child.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
});

describe('studio: security', () => {
  it('serves the app only with the token, with a strict CSP', async () => {
    expect((await http(studio, 'GET', '/')).status).toBe(403);
    const page = await http(studio, 'GET', `/?t=${studio.token}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('vcs-protection studio');
    expect(String(page.headers['content-security-policy'])).toMatch(/script-src 'nonce-[^']+'/);
    expect(page.headers['x-frame-options']).toBe('DENY');
  });

  it('refuses API calls without the token, with a foreign Host, cross-origin POSTs, and non-JSON bodies', async () => {
    expect((await http(studio, 'GET', '/api/state')).status).toBe(403);
    expect((await api(studio, '/api/state', { 'X-Studio-Token': 'wrong' })).status).toBe(403);
    expect((await api(studio, '/api/state', { Host: 'evil.com' })).status).toBe(403);
    expect((await act(studio, 'repairHooks', {}, { Origin: 'http://evil.com' })).status).toBe(403);
    const text = await http(studio, 'POST', '/api/actions/repairHooks', { headers: { 'X-Studio-Token': studio.token }, body: 'x' });
    expect(text.status).toBe(415);
    const big = await act(studio, 'protect', { pattern: 'x'.repeat(1_200_000) });
    expect(big.status).toBe(413);
    expect((await act(studio, 'rmrf', {})).status).toBe(404);
    expect(String((await api(studio, '/api/state')).headers['access-control-allow-origin'] ?? '')).toBe('');
  });
});

describe('studio: actions', () => {
  it('reports the state of a repository without rules', async () => {
    const st = (await api(studio, '/api/state')).json();
    // git prints the canonical root: symlinks resolved (/var -> /private/var on macOS),
    // 8.3 short names expanded and forward slashes on Windows.
    expect(path.resolve(st.repo.root)).toBe(realpathSync.native(repo));
    expect(st.repo.rules).toBeNull();
    expect(st.repo.hooks.list).toHaveLength(6);
    expect(st.global.installed).toBe(false);
  });

  it('initializes, then protects a pattern (file only) with the same output as the CLI', async () => {
    const init = (await act(studio, 'init', { branches: 'main', approvals: 1, github: true })).json();
    expect(init.ok, JSON.stringify(init)).toBe(true);
    expect(init.output[0].text).toContain('Created .vcs-protection.json protecting: main');

    const bad = await act(studio, 'protect', { pattern: 'x', approvals: -1 });
    expect(bad.status).toBe(400);
    expect(bad.json().issues[0].path).toBe('approvals');

    const res = (await act(studio, 'protect', { pattern: 'release/*', approvals: 2, share: 'file' })).json();
    expect(res.ok).toBe(true);
    expect(res.output.map((l: { text: string }) => l.text).join('\n')).toContain("'release/*' is now protected (2 approval(s) required).");
    const cfg = JSON.parse(readFileSync(path.join(repo, '.vcs-protection.json'), 'utf8'));
    expect(cfg.protected.map((r: { pattern: string }) => r.pattern)).toEqual(['main', 'release/*']);
  });

  it('validates settings with the config schema and regenerates the workflow', async () => {
    const bad = (await act(studio, 'updateSettings', { patch: { github: { sweep: 'hourly' } }, share: 'file' })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('github.sweep: must be a 5-field cron');
    const good = (await act(studio, 'updateSettings', { patch: { github: { sweep: '0 * * * *' }, failMode: 'closed' }, share: 'file' })).json();
    expect(good.ok, JSON.stringify(good)).toBe(true);
    const cfg = JSON.parse(readFileSync(path.join(repo, '.vcs-protection.json'), 'utf8'));
    expect(cfg.github.sweep).toBe('0 * * * *');
    expect(cfg.failMode).toBe('closed');
    expect(readFileSync(path.join(repo, '.github/workflows/vcs-protection-guard.yml'), 'utf8')).toContain("cron: '0 * * * *'");
  });

  it('repairs a deleted hook and reports doctor checks as data', async () => {
    unlinkSync(path.join(repo, '.git', 'hooks', 'pre-push'));
    const before = (await api(studio, '/api/doctor')).json();
    expect(before.checks.find((c: { name: string }) => c.name === 'hook pre-push')).toMatchObject({ ok: false, fixable: true });
    const res = (await act(studio, 'repairHooks', {})).json();
    expect(res.output.map((l: { text: string }) => l.text).join('\n')).toContain('hook pre-push');
    expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-push'))).toBe(true);
  });

  it('installs and removes the global template', async () => {
    expect((await act(studio, 'installGlobal', { force: false })).json().ok).toBe(true);
    expect((await api(studio, '/api/state')).json().global.installed).toBe(true);
    expect((await act(studio, 'uninstallGlobal', {})).json().ok).toBe(true);
    expect((await api(studio, '/api/state')).json().global.installed).toBe(false);
  });
});

describe('studio: lifecycle', () => {
  it('works outside a git repository (machine section only)', async () => {
    const plain = path.join(tmp, 'plain');
    mkdirSync(plain);
    const s = await startStudio(plain);
    try {
      expect((await api(s, '/api/state')).json().repo).toBeNull();
    } finally {
      s.child.kill('SIGKILL');
    }
  });

  // child.kill() on Windows is always TerminateProcess, so a SIGINT handler can't be exercised from a test.
  it.skipIf(process.platform === 'win32')('stops cleanly on Ctrl+C', async () => {
    const s = await startStudio(tmp);
    const exit = new Promise<number | null>((r) => s.child.on('exit', (code) => r(code)));
    s.child.kill('SIGINT');
    expect(await exit).toBe(0);
    expect(s.out()).toContain('Studio stopped.');
  });

  it('rejects an invalid --port', () => {
    const r = spawnSync(process.execPath, [CLI, 'studio', '--no-open', '--port', 'abc'], { cwd: repo, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Invalid --port: 'abc'");
  });
});
