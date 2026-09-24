import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readAuditLog } from '../audit/log.js';
import { CONFIG_FILE } from '../config/schema.js';
import { renderWorkflow, WORKFLOW_PATH } from '../github/workflow.js';
import { gitMaybe } from '../git/exec.js';
import { gitVersion, hooksDir, requireRepoRoot } from '../git/repo.js';
import { hookStatus, installHooks } from '../hooks/install.js';
import { VERSION } from '../version.js';
import { c, info } from '../ui.js';
import { requireEffectiveConfig } from './shared.js';

export function list(opts: { json?: boolean }): void {
  const loaded = requireEffectiveConfig();
  if (opts.json) {
    info(JSON.stringify({ source: loaded.source, location: loaded.location, ...loaded.config }, null, 2));
    return;
  }
  info(`Rules from ${c.bold(loaded.location)} (${loaded.source})`);
  if (loaded.config.protected.length === 0) info('  No protected branches.');
  for (const r of loaded.config.protected) {
    info(`  ${c.cyan(r.pattern.padEnd(24))} approvals: ${r.requiredApprovals}   deletion: ${r.allowDeletion ? 'allowed' : 'blocked'}`);
  }
}

export function status(): void {
  list({});
  const loaded = requireEffectiveConfig();
  info('');
  info(`Hooks (${hooksDir()}):`);
  for (const h of hookStatus(loaded.config.failMode)) {
    const mark = h.state === 'installed' ? c.green('✔') : c.red('✖');
    info(`  ${mark} ${h.hook.padEnd(22)} ${h.state}${h.chained ? ' (chains ' + h.hook + '.local)' : ''}`);
  }
  const bypasses = readAuditLog();
  info('');
  info(`Local bypasses logged: ${bypasses.length}${bypasses.length ? ` (last: ${bypasses.at(-1)!.time})` : ''}`);
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fixable?: boolean;
}

export function doctor(opts: { fix?: boolean }): number {
  const root = requireRepoRoot();
  const loaded = requireEffectiveConfig();
  const checks: Check[] = [];

  const [maj, min, patch] = gitVersion();
  checks.push({ name: 'git version', ok: maj > 2 || (maj === 2 && min >= 28), detail: `${maj}.${min}.${patch} (need >= 2.28)` });

  checks.push({ name: 'config', ok: true, detail: `${loaded.location} (${loaded.source})` });
  if (loaded.source === 'local') {
    checks.push({
      name: 'config shared',
      ok: false,
      detail: `${CONFIG_FILE} is not on the remote default branch yet; teammates don't have these rules.`,
    });
  }

  const hooksPath = gitMaybe(['config', 'core.hooksPath']);
  checks.push({ name: 'core.hooksPath', ok: true, detail: hooksPath ? `set to ${hooksPath}` : 'default (.git/hooks)' });

  for (const h of hookStatus(loaded.config.failMode)) {
    checks.push({ name: `hook ${h.hook}`, ok: h.state === 'installed', detail: h.state, fixable: h.state !== 'foreign' });
  }

  const wf = path.join(root, WORKFLOW_PATH);
  if (!existsSync(wf)) {
    checks.push({ name: 'GitHub guard', ok: false, detail: `missing ${WORKFLOW_PATH} (run \`vcs-protection github setup\`)` });
  } else {
    const current = readFileSync(wf, 'utf8');
    const pinned = current.match(/vcs-protection@([^\s]+)/)?.[1] ?? VERSION;
    const inSync = current === renderWorkflow(loaded.config, pinned);
    checks.push({
      name: 'GitHub guard',
      ok: inSync,
      detail: inSync ? `present (pinned to ${pinned})` : 'out of date with the config (run `vcs-protection github setup`)',
    });
  }

  if (opts.fix) {
    const broken = hookStatus(loaded.config.failMode).filter((h) => h.state === 'missing' || h.state === 'outdated');
    if (broken.length) {
      installHooks(loaded.config.failMode, undefined, broken.map((b) => b.hook));
      for (const ch of checks) if (ch.name.startsWith('hook ') && ch.fixable) Object.assign(ch, { ok: true, detail: 'repaired' });
    }
  }

  for (const ch of checks) info(`${ch.ok ? c.green('✔') : c.red('✖')} ${ch.name.padEnd(28)} ${ch.detail}`);
  const failed = checks.filter((ch) => !ch.ok);
  if (failed.length && !opts.fix && failed.some((f) => f.fixable)) info(c.dim('\nRun `vcs-protection doctor --fix` to repair hooks.'));
  return failed.length ? 1 : 0;
}
