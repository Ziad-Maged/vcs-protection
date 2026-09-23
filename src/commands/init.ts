import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, localConfigPath } from '../config/load.js';
import { CONFIG_FILE, defaultConfig } from '../config/schema.js';
import { gitMaybe } from '../git/exec.js';
import { currentBranch, gitVersion, remoteDefaultRef, requireRepoRoot } from '../git/repo.js';
import { installHooks } from '../hooks/install.js';
import { WORKFLOW_PATH } from '../github/workflow.js';
import { BYPASS_ENV } from '../hooks/context.js';
import { c, info, warn } from '../ui.js';
import { prompt, writeConfig, writeWorkflow } from './shared.js';

export interface InitOptions {
  branches?: string;
  approvals?: string;
  github?: boolean;
}

export function assertGitVersion(): void {
  const [maj, min] = gitVersion();
  if (maj < 2 || (maj === 2 && min < 28)) {
    throw new Error(`git ${maj}.${min} is too old: vcs-protection needs git >= 2.28 (reference-transaction hook).`);
  }
}

export async function init(opts: InitOptions): Promise<void> {
  assertGitVersion();
  const root = requireRepoRoot();

  let loaded = loadConfig();
  let created = false;
  if (!loaded) {
    const defaultRef = remoteDefaultRef('origin');
    const guess = defaultRef ? defaultRef.replace(/^refs\/remotes\/origin\//, '') : (currentBranch() ?? 'main');
    const answer = opts.branches ?? (await prompt('Branches to protect (comma-separated, globs allowed)', guess));
    const branches = answer.split(',').map((s) => s.trim()).filter(Boolean);
    const approvals = Number(opts.approvals ?? (await prompt('Required approvals per pull request', '1')));
    if (!Number.isInteger(approvals) || approvals < 0) throw new Error(`Invalid approvals: ${approvals}`);
    const file = localConfigPath()!;
    writeConfig(file, defaultConfig(branches, approvals));
    info(`${c.green('✔')} Created ${CONFIG_FILE} protecting: ${branches.join(', ')}`);
    loaded = loadConfig()!;
    created = true;
  } else {
    info(`${c.green('✔')} Using rules from ${loaded.location}`);
  }

  const hooksPath = gitMaybe(['config', 'core.hooksPath']);
  if (hooksPath) warn(`core.hooksPath is set to '${hooksPath}'; hooks are installed there and chained with existing ones.`);

  const res = installHooks(loaded.config.failMode);
  info(`${c.green('✔')} Installed git hooks in ${res.dir}: ${res.written.join(', ')}`);
  if (res.chained.length) info(`  Existing hooks kept and chained as *.local: ${res.chained.join(', ')}`);
  for (const w of res.warnings) warn(w);

  let wroteWorkflow = false;
  if (opts.github) {
    const file = writeWorkflow(loaded.config);
    info(`${c.green('✔')} Wrote GitHub guard workflow: ${path.relative(root, file)}`);
    wroteWorkflow = true;
  } else if (!existsSync(path.join(root, WORKFLOW_PATH))) {
    info(c.dim(`  Tip: run \`vcs-protection github setup\` to add the server-side GitHub Actions guard.`));
  }

  if (created || wroteWorkflow) {
    const files = [CONFIG_FILE, ...(wroteWorkflow ? [WORKFLOW_PATH] : [])].join(' ');
    info('');
    info(c.bold('Next: share the rules with your team.'));
    info(`  The new rules already apply locally, so commit them through a pull request:`);
    info(`    git switch -c chore/vcs-protection && git add ${files} && git commit -m "Add branch protection rules"`);
    info(`    git push -u origin chore/vcs-protection   # then open a PR`);
    info(`  Brand-new repository with nothing on the remote yet? Bootstrap once with:`);
    info(`    ${BYPASS_ENV}="initial setup" git commit ...  and  ${BYPASS_ENV}="initial setup" git push`);
  }
  info('');
  info(`Teammates: add it as a dev dependency (${c.cyan('npm i -D vcs-protection')}) and every ${c.cyan('npm install')} sets up the hooks.`);
  info(`  npm >= 12 blocks dependency install scripts: also run ${c.cyan('npm install-scripts approve vcs-protection')} and commit package.json.`);
  info(`  Otherwise run ${c.cyan('vcs-protection init')} once per clone (or ${c.cyan('npm i -g vcs-protection')} to cover every future clone).`);
}
