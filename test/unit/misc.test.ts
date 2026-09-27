import { describe, expect, it } from 'vitest';
import { applyProtect, applyUnprotect } from '../../src/commands/rules.js';
import { defaultConfig, parseConfig } from '../../src/config/schema.js';
import { compareUrl, parseGitHubRemote } from '../../src/github/remote.js';
import { CONCURRENCY_KEY, renderWorkflow } from '../../src/github/workflow.js';
import { parseRefUpdates } from '../../src/hooks/handlers.js';
import { renderShim } from '../../src/hooks/shim.js';
import { blockMessage } from '../../src/messages.js';

describe('parseGitHubRemote', () => {
  it.each([
    ['https://github.com/acme/app.git', 'acme', 'app'],
    ['https://github.com/acme/app', 'acme', 'app'],
    ['https://user@github.com/acme/app.git', 'acme', 'app'],
    ['git@github.com:acme/app.git', 'acme', 'app'],
    ['ssh://git@github.com/acme/app.git', 'acme', 'app'],
    ['git@github-work:acme/app.git', 'acme', 'app'],
  ])('%s', (url, owner, repo) => {
    expect(parseGitHubRemote(url)).toMatchObject({ owner, repo });
  });

  it('rejects non-GitHub remotes', () => {
    expect(parseGitHubRemote('https://gitlab.com/acme/app.git')).toBeNull();
    expect(parseGitHubRemote('/tmp/origin.git')).toBeNull();
  });

  it('builds compare URLs', () => {
    const r = parseGitHubRemote('git@github.com:acme/app.git')!;
    expect(compareUrl(r, 'main', 'feature/x')).toBe('https://github.com/acme/app/compare/main...feature/x?expand=1');
  });
});

describe('config', () => {
  it('applies defaults', () => {
    const c = parseConfig('{"version":1,"protected":[{"pattern":"main"}]}', 'test');
    expect(c.remote).toBe('origin');
    expect(c.protected[0]).toEqual({ pattern: 'main', requiredApprovals: 1, allowDeletion: false });
    expect(c.bypass.allowed).toBe(true);
    expect(c.github.enforcement).toBe('revert');
    expect(c.github.poisonPill).toEqual({ enabled: false, workflows: [], checks: [], conclusions: ['failure', 'timed_out'] });
    expect(c.failMode).toBe('open');
    expect(defaultConfig(['main']).github.poisonPill.enabled).toBe(false);
  });

  it('validates the guard settings', () => {
    const cfg = (github: object) => JSON.stringify({ version: 1, github });
    const c = parseConfig(cfg({}), 'x.json');
    expect(c.github).toMatchObject({ dismissStaleApprovals: false, sweep: '*/30 * * * *', guardLogin: 'github-actions[bot]' });
    expect(parseConfig(cfg({ sweep: null }), 'x.json').github.sweep).toBeNull();
    expect(() => parseConfig(cfg({ sweep: 'hourly' }), 'x.json')).toThrow(/github.sweep: must be a 5-field cron/);
    expect(() => parseConfig(cfg({ guardLogin: 'mallory' }), 'x.json')).toThrow(/github.guardLogin: must be a bot account/);
    for (const bad of ['rescue ', 'a..b/', '-x/', '/x', 'x//y', 'x/.hidden/', 'x.lock/y']) {
      expect(() => parseConfig(cfg({ rescueBranchPrefix: bad }), 'x.json'), bad).toThrow(/rescueBranchPrefix/);
    }
    expect(parseConfig(cfg({ rescueBranchPrefix: 'rescued/' }), 'x.json').github.rescueBranchPrefix).toBe('rescued/');
  });

  it('validates the poison pill', () => {
    const cfg = (pill: unknown) => JSON.stringify({ version: 1, github: { poisonPill: pill } });
    expect(() => parseConfig(cfg({ enabled: true }), 'x.json')).toThrow(/github.poisonPill.workflows: list at least one workflow/);
    expect(() => parseConfig(cfg({ enabled: true, workflows: ['CI'], conclusions: ['exploded'] }), 'x.json')).toThrow(/conclusions/);
    expect(parseConfig(cfg({ enabled: true, workflows: ['CI'] }), 'x.json').github.poisonPill.conclusions).toEqual(['failure', 'timed_out']);
  });

  it('reports invalid configs clearly', () => {
    expect(() => parseConfig('{"version":2}', 'x.json')).toThrow(/x.json: invalid configuration/);
    expect(() => parseConfig('{', 'x.json')).toThrow(/invalid JSON/);
  });

  it('protect / unprotect edit rules', () => {
    let c = defaultConfig(['main']);
    c = applyProtect(c, 'release/*', 2);
    expect(c.protected.map((r) => r.pattern)).toEqual(['main', 'release/*']);
    c = applyProtect(c, 'main', 3);
    expect(c.protected.find((r) => r.pattern === 'main')?.requiredApprovals).toBe(3);
    c = applyUnprotect(c, 'main');
    expect(c.protected.map((r) => r.pattern)).toEqual(['release/*']);
    expect(() => applyUnprotect(c, 'release/1.0')).toThrow(/protected by pattern 'release\/\*'/);
    expect(() => applyUnprotect(c, 'nope')).toThrow(/not protected/);
  });
});

describe('parseRefUpdates', () => {
  it('keeps object-id updates and skips symref updates', () => {
    const a = 'a'.repeat(40);
    const z = '0'.repeat(40);
    const input = `${z} ${a} refs/heads/main\nref:refs/heads/main ref:refs/heads/dev HEAD\n\n`;
    expect(parseRefUpdates(input)).toEqual([{ oldSha: z, newSha: a, ref: 'refs/heads/main' }]);
  });
});

describe('rendering', () => {
  it('shim embeds paths with forward slashes and chains .local', () => {
    const s = renderShim({ hook: 'pre-push', nodePath: 'C:\\node\\node.exe', cliPath: "C:\\it's\\cli.js", failMode: 'open' });
    expect(s).toContain(`VCSP_NODE='C:/node/node.exe'`);
    expect(s).toContain(`VCSP_CLI='C:/it'\\''s/cli.js'`);
    expect(s).toContain('pre-push.local');
    expect(s).toContain('VCSP_INPUT=$(cat)');
  });

  it('workflow lists protected patterns and pins the version', () => {
    const wf = renderWorkflow(defaultConfig(['main', 'release/*']), '1.2.3');
    expect(wf).toContain("      - 'main'\n      - 'release/*'");
    expect(wf).toContain('npx --yes vcs-protection@1.2.3 ci-guard');
    expect(wf).not.toContain('  workflow_run:\n'); // no trigger (the concurrency expression mentions it)
    expect(wf).not.toContain('checks: read');
    expect(wf).toContain("  schedule:\n    - cron: '*/30 * * * *'\n  workflow_dispatch:\n");
    const noSweep = defaultConfig(['main']);
    noSweep.github.sweep = null;
    expect(renderWorkflow(noSweep, '1.2.3')).not.toContain('schedule:');
    expect(renderWorkflow(noSweep, '1.2.3')).toContain('  workflow_dispatch:\n');
    expect(wf).toContain(`group: vcs-protection-\${{ ${CONCURRENCY_KEY} }}`);
    expect(wf).toContain("format('pill-{0}', github.run_id)");
    expect(wf).toContain("format('branch-{0}', github.ref_name)");
    expect(wf).toContain('      baseline:\n        description:');
    expect(wf).toContain("          VCS_PROTECTION_GUARD_LOGIN: 'github-actions[bot]'\n");
  });

  it('workflow listens to critical workflows when the poison pill is on', () => {
    const c = defaultConfig(['main', 'release/*']);
    c.github.poisonPill = { enabled: true, workflows: ['CI', "Bob's E2E"], checks: [], conclusions: ['failure'] };
    const wf = renderWorkflow(c, '1.2.3');
    expect(wf).toContain(
      "  workflow_run:\n    workflows: ['CI', 'Bob''s E2E']\n    types: [completed]\n    branches:\n      - 'main'\n      - 'release/*'\n",
    );
    expect(wf).toContain('  statuses: write\n  checks: read\n  actions: read\n');
    expect(wf).toContain(`group: vcs-protection-\${{ ${CONCURRENCY_KEY} }}`);
  });

  it('merge messages include a PR compare link', () => {
    const msg = blockMessage({
      kind: 'advance',
      branch: 'main',
      rule: { pattern: 'main', requiredApprovals: 2, allowDeletion: false },
      repo: parseGitHubRemote('git@github.com:acme/app.git'),
      op: 'merge',
      sourceBranch: 'feature/x',
      bypassAllowed: true,
    });
    expect(msg.title).toMatch(/Merging into protected branch 'main'/);
    expect(msg.lines.join('\n')).toContain('approved by 2 other team members');
    expect(msg.lines.join('\n')).toContain('https://github.com/acme/app/compare/main...feature/x');
  });
});
